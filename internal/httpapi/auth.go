package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/oaldesi/qa-portal/internal/authn"
	"github.com/oaldesi/qa-portal/internal/model"
)

// userView is a user as the client sees it, plus whether they can sign in.
type userView struct {
	model.User
	HasPassword bool `json:"has_password"`
}

func view(u model.User) userView { return userView{User: u, HasPassword: u.HasPassword()} }

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var in struct{ Email, Password string }
	if !decode(w, r, &in) {
		return
	}
	u, token, err := s.authn.Login(r.Context(), in.Email, in.Password)
	if err != nil {
		msg := authn.ErrInvalidCredentials.Error()
		if errors.Is(err, authn.ErrPasswordNotSet) || errors.Is(err, authn.ErrInactive) {
			msg = err.Error()
		}
		writeError(w, http.StatusUnauthorized, msg)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": token, "user": view(*u)})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, view(*me(r)))
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	token, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	_ = s.authn.Logout(r.Context(), token)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	var in struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if !decode(w, r, &in) {
		return
	}
	token, err := s.authn.ChangeOwnPassword(r.Context(), me(r).ID, in.CurrentPassword, in.NewPassword)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": token})
}
