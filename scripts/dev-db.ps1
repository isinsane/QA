<#
.SYNOPSIS
    Manages a project-local Postgres instance for development.

.DESCRIPTION
    The scoop Postgres install ships the server binaries but registers no
    Windows service, so this script runs a cluster out of ./.pgdata that is
    owned by this project and safe to delete.

    Trust authentication is used and the cluster listens on localhost only.
    This is a development convenience and must not be used for anything else.

.EXAMPLE
    ./scripts/dev-db.ps1 init     # create the cluster and the databases
    ./scripts/dev-db.ps1 start
    ./scripts/dev-db.ps1 status
    ./scripts/dev-db.ps1 psql
    ./scripts/dev-db.ps1 stop
    ./scripts/dev-db.ps1 reset    # destroy and recreate from scratch
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('init', 'start', 'stop', 'status', 'reset', 'psql')]
    [string]$Command = 'status',

    [int]$Port = 5433
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $RepoRoot '.pgdata'
$LogFile = Join-Path $DataDir 'server.log'
$SuperUser = 'postgres'
$DevDb = 'qa_dev'
$TestDb = 'qa_test'

function Assert-Tool([string]$name) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        throw "$name not found on PATH. Install Postgres (e.g. 'scoop install postgresql')."
    }
}

function Test-Running {
    if (-not (Test-Path $DataDir)) { return $false }
    & pg_ctl -D $DataDir status *> $null
    return $LASTEXITCODE -eq 0
}

function Invoke-Init {
    Assert-Tool initdb
    if (Test-Path $DataDir) {
        Write-Host "Cluster already exists at $DataDir"
    }
    else {
        Write-Host "Initialising cluster at $DataDir ..."
        & initdb --pgdata=$DataDir --username=$SuperUser --auth=trust --encoding=UTF8 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }

        # Bind to loopback only; this cluster is never reachable off-box.
        Add-Content -Path (Join-Path $DataDir 'postgresql.conf') -Value @"

# Set by scripts/dev-db.ps1
listen_addresses = 'localhost'
port = $Port
"@
    }

    Invoke-Start

    foreach ($name in @($DevDb, $TestDb)) {
        $exists = (& psql -h localhost -p $Port -U $SuperUser -d postgres -tAc `
                "SELECT 1 FROM pg_database WHERE datname = '$name'" | Out-String).Trim()
        if ($exists -ne '1') {
            Write-Host "Creating database $name ..."
            & createdb -h localhost -p $Port -U $SuperUser $name
        }
        else {
            Write-Host "Database $name already exists"
        }
    }

    Write-Host ''
    Write-Host 'Ready. Add this to your .env:'
    Write-Host "  DATABASE_URL=postgres://${SuperUser}@localhost:${Port}/${DevDb}?sslmode=disable"
}

function Invoke-Start {
    Assert-Tool pg_ctl
    if (-not (Test-Path $DataDir)) { throw "No cluster at $DataDir. Run: ./scripts/dev-db.ps1 init" }
    if (Test-Running) { Write-Host "Already running on port $Port"; return }

    Write-Host "Starting Postgres on port $Port ..."
    & pg_ctl -D $DataDir -l $LogFile -o "-p $Port" -w start
    if ($LASTEXITCODE -ne 0) { throw "pg_ctl start failed; see $LogFile" }
}

function Invoke-Stop {
    Assert-Tool pg_ctl
    if (-not (Test-Running)) { Write-Host 'Not running'; return }
    & pg_ctl -D $DataDir -m fast -w stop
}

function Invoke-Status {
    if (-not (Test-Path $DataDir)) {
        Write-Host "No cluster at $DataDir. Run: ./scripts/dev-db.ps1 init"
        return
    }
    & pg_ctl -D $DataDir status
}

function Invoke-Reset {
    if (Test-Running) { Invoke-Stop }
    if (Test-Path $DataDir) {
        Write-Host "Removing $DataDir ..."
        Remove-Item -Recurse -Force $DataDir
    }
    Invoke-Init
}

switch ($Command) {
    'init' { Invoke-Init }
    'start' { Invoke-Start }
    'stop' { Invoke-Stop }
    'status' { Invoke-Status }
    'reset' { Invoke-Reset }
    'psql' { & psql -h localhost -p $Port -U $SuperUser -d $DevDb }
}
