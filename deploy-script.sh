#!/usr/bin/env bash
# Deploy the QA Portal on the server it runs on. The server needs Docker
# (with compose) and git; Go, Node and Postgres live inside the images.
#
#   First time:  git clone https://github.com/isinsane/QA.git ~/QA && ~/QA/deploy-script.sh
#   Updates:     ~/QA/deploy-script.sh               (pulls the current branch)
#                ~/QA/deploy-script.sh -b main       (another branch)
#                ~/QA/deploy-script.sh -n            (rebuild what is here, no pull)
#
# Pulls from GitHub, builds the image, starts Postgres and the app (the app
# runs the database migrations when it starts) and waits until it answers.
# Safe to re-run: .env and the database volume are never touched. The first
# run creates .env with a generated Postgres password and a free port.
set -euo pipefail

BRANCH=""
PULL=1

while getopts ":b:n?" opt; do
	case "$opt" in
	b) BRANCH="$OPTARG" ;;
	n) PULL=0 ;;
	*)
		sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	esac
done

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
die() {
	printf '\033[1;31mdeploy:\033[0m %s\n' "$*" >&2
	exit 1
}

cd "$(dirname "$0")"
SELF="./$(basename "$0")"

# ---- what the server needs ----
command -v git >/dev/null || die "git is not installed (sudo apt install git)"
docker compose version >/dev/null 2>&1 || die "$(
	cat <<-EOF
		'docker compose' is not available. Install Docker with the compose plugin:
		  curl -fsSL https://get.docker.com | sudo sh
	EOF
)"
docker info >/dev/null 2>&1 || die "$(
	cat <<-EOF
		$(whoami) cannot talk to Docker. Add the user to the docker group:
		  sudo usermod -aG docker $(whoami)    # then log out and back in
	EOF
)"

# ---- latest code ----
if [ "$PULL" -eq 1 ]; then
	git diff --quiet && git diff --cached --quiet ||
		die "this checkout has local changes; the server only deploys what is on GitHub (git status to see them)"
	[ -n "$BRANCH" ] || BRANCH="$(git rev-parse --abbrev-ref HEAD)"
	say "Pulling $BRANCH"
	before="$(git rev-parse HEAD)"
	# Fast-forward only: a merge made here would exist nowhere else.
	git fetch --quiet origin "$BRANCH"
	git checkout --quiet "$BRANCH"
	git merge --ff-only --quiet "origin/$BRANCH"
	# Bash reads a script as it runs, so if the pull changed this file, carry
	# on with the new copy (with -n: the pull is done).
	if [ "$before" != "$(git rev-parse HEAD)" ] && [ -z "${QA_DEPLOY_REEXEC:-}" ] &&
		! git diff --quiet "$before" HEAD -- "$SELF"; then
		say "The deploy script changed in that pull; restarting with the new one"
		QA_DEPLOY_REEXEC=1 exec "$SELF" -n
	fi
fi

# ---- .env ----
port_in_use() { ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"; }
# The value of KEY in .env, or empty (never fails, so set -e can't trip on it).
env_value() { { grep -E "^$1=" .env 2>/dev/null || true; } | tail -1 | cut -d= -f2-; }

if [ ! -f .env ]; then
	cp .env.example .env
	password="$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
	port=8090
	while port_in_use "$port"; do port=$((port + 1)); done
	sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$password/; s/^HTTP_PORT=.*/HTTP_PORT=$port/; s/^APP_ENV=.*/APP_ENV=prod/" .env
	chmod 600 .env
	warn "Created $(pwd)/.env with a generated Postgres password and port $port."
	warn "Ticket pulls stay off until QA_API_KEY, QA_API_BASE_URL (and EDESK_API_TOKEN) are filled in there; re-run this script after."
fi

password="$(env_value POSTGRES_PASSWORD)"
[ -n "$password" ] || die "POSTGRES_PASSWORD is empty in $(pwd)/.env; set it (openssl rand -hex 24) and run again"
# The app's connection string is key=value pairs: a space or quote in the
# password would break it.
case "$password" in *[[:space:]\"\']*) die "POSTGRES_PASSWORD contains a space or quote; use openssl rand -hex 24" ;; esac

port="$(env_value HTTP_PORT)"
port="${port:-8090}"
# Free, or already ours from the last deploy.
if port_in_use "$port" && [ -z "$(docker compose ps -q app 2>/dev/null)" ]; then
	die "port $port is taken by something else on this server; set another HTTP_PORT in $(pwd)/.env"
fi

# ---- build and start ----
say "Deploying $(git rev-parse --short HEAD) ($(git rev-parse --abbrev-ref HEAD)) on port $port"
# Which daily pulls this deploy will run (keys stay in .env, never printed).
if [ -n "$(env_value QA_API_KEY)" ] && [ -n "$(env_value QA_API_BASE_URL)" ]; then
	say "Tickets pull: on"
else
	warn "Tickets pull: off (fill QA_API_KEY and QA_API_BASE_URL in $(pwd)/.env)"
fi
if [ -n "$(env_value EDESK_API_TOKEN)" ]; then
	say "Live chat pull and eDesk ticket info: on"
else
	warn "Live chat pull and eDesk ticket info: off (fill EDESK_API_TOKEN in $(pwd)/.env)"
fi
docker compose config --quiet || die "compose.yaml or .env is invalid; nothing was started or stopped"
docker compose up -d --build --remove-orphans
# Each build leaves a Go and a Node stage behind.
docker image prune -f >/dev/null 2>&1 || true

say "Waiting for the portal"
for _ in $(seq 1 45); do
	if curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 ||
		wget -qO- "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
		echo
		docker compose ps
		say "QA Portal is up: http://$(hostname -I 2>/dev/null | awk '{print $1}'):$port"
		# A fresh database has nobody to sign in with yet.
		dbuser="$(env_value POSTGRES_USER)"
		dbname="$(env_value POSTGRES_DB)"
		admins="$(docker compose exec -T db psql -U "${dbuser:-qa}" -d "${dbname:-qa}" -tAc \
			"SELECT count(*) FROM users WHERE role = 'admin' AND active" 2>/dev/null || true)"
		if [ "${admins//[[:space:]]/}" = "0" ]; then
			warn "No admin yet. Create the first one (it asks for a password):"
			echo "  cd $(pwd) && docker compose exec app set-password -email you@company.com -name \"Your Name\""
		fi
		exit 0
	fi
	sleep 2
done

docker compose logs --tail 40 app >&2 || true
die "the portal did not answer /healthz on port $port; logs above (more: cd $(pwd) && docker compose logs app)"
