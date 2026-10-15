// Package authn is login: bcrypt passwords and opaque bearer sessions.
// Copied from followup-portal, renamed agent → user.
package authn

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"

	"github.com/oaldesi/qa-portal/internal/model"
	"github.com/oaldesi/qa-portal/internal/settings"
)

var (
	// Same error for unknown email and wrong password, so login cannot be used
	// to discover which emails exist.
	ErrInvalidCredentials   = errors.New("invalid email or password")
	ErrPasswordNotSet       = errors.New("no password set for this account yet — ask your supervisor or an admin to set one")
	ErrInactive             = errors.New("this account is not active")
	ErrSessionNotFound      = errors.New("session not found or expired")
	ErrWrongCurrentPassword = errors.New("current password is incorrect")
)

const sessionTTL = 30 * 24 * time.Hour

type Service struct{ db *gorm.DB }

func NewService(db *gorm.DB) *Service { return &Service{db: db} }

func HashPassword(plain string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(plain), bcrypt.DefaultCost)
	if err != nil {
		return "", fmt.Errorf("authn: hash password: %w", err)
	}
	return string(hash), nil
}

// Login checks email + password and issues a session. The raw token is
// returned once; only its hash is stored.
func (s *Service) Login(ctx context.Context, email, password string) (*model.User, string, error) {
	email = strings.TrimSpace(email)
	if email == "" || password == "" {
		return nil, "", ErrInvalidCredentials
	}
	var u model.User
	if err := s.db.WithContext(ctx).Where("lower(email) = lower(?)", email).First(&u).Error; err != nil {
		return nil, "", ErrInvalidCredentials
	}
	if !u.Active {
		return nil, "", ErrInactive
	}
	if u.PasswordHash == "" {
		// Nobody has given them a password yet: the default (an admin
		// setting) lets them in once, and they must choose their own.
		def := settings.Load(ctx, s.db).DefaultPassword
		if def == "" {
			return nil, "", ErrPasswordNotSet
		}
		if subtle.ConstantTimeCompare([]byte(password), []byte(def)) != 1 {
			return nil, "", ErrInvalidCredentials
		}
		if err := s.db.WithContext(ctx).Model(&u).Update("must_change_password", true).Error; err != nil {
			return nil, "", err
		}
		u.MustChangePassword = true
	} else if bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(password)) != nil {
		return nil, "", ErrInvalidCredentials
	}
	token, err := s.issueSession(ctx, u.ID)
	return &u, token, err
}

func (s *Service) issueSession(ctx context.Context, userID uuid.UUID) (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("authn: generate token: %w", err)
	}
	raw := base64.RawURLEncoding.EncodeToString(b)
	now := time.Now().UTC()
	err := s.db.WithContext(ctx).Create(&model.Session{
		UserID: userID, TokenHash: hashToken(raw),
		CreatedAt: now, ExpiresAt: now.Add(sessionTTL), LastSeenAt: now,
	}).Error
	if err != nil {
		return "", fmt.Errorf("authn: create session: %w", err)
	}
	return raw, nil
}

// Authenticate resolves a bearer token to its active user.
func (s *Service) Authenticate(ctx context.Context, rawToken string) (*model.User, error) {
	if strings.TrimSpace(rawToken) == "" {
		return nil, ErrSessionNotFound
	}
	var sess model.Session
	err := s.db.WithContext(ctx).
		Where("token_hash = ? AND revoked_at IS NULL AND expires_at > now()", hashToken(rawToken)).
		First(&sess).Error
	if err != nil {
		return nil, ErrSessionNotFound
	}
	var u model.User
	if err := s.db.WithContext(ctx).First(&u, "id = ? AND active", sess.UserID).Error; err != nil {
		return nil, ErrSessionNotFound
	}
	s.db.WithContext(ctx).Model(&model.Session{}).Where("id = ?", sess.ID).Update("last_seen_at", time.Now().UTC())
	return &u, nil
}

func (s *Service) Logout(ctx context.Context, rawToken string) error {
	return s.db.WithContext(ctx).Model(&model.Session{}).
		Where("token_hash = ? AND revoked_at IS NULL", hashToken(rawToken)).
		Update("revoked_at", time.Now().UTC()).Error
}

// SetPassword stores a new password and revokes every session for the user.
// adminSet forces a change at next login. Returns a fresh session token for
// the caller when they changed their own password.
func (s *Service) SetPassword(ctx context.Context, userID uuid.UUID, plain string, adminSet bool) (string, error) {
	if len(plain) < 8 {
		return "", errors.New("password must be at least 8 characters")
	}
	hash, err := HashPassword(plain)
	if err != nil {
		return "", err
	}
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&model.User{}).Where("id = ?", userID).Updates(map[string]any{
			"password_hash": hash, "must_change_password": adminSet,
		}).Error; err != nil {
			return err
		}
		return tx.Model(&model.Session{}).Where("user_id = ? AND revoked_at IS NULL", userID).
			Update("revoked_at", time.Now().UTC()).Error
	})
	if err != nil {
		return "", fmt.Errorf("authn: set password: %w", err)
	}
	if adminSet {
		return "", nil
	}
	return s.issueSession(ctx, userID)
}

// ChangeOwnPassword is SetPassword gated on the current password.
func (s *Service) ChangeOwnPassword(ctx context.Context, userID uuid.UUID, current, next string) (string, error) {
	var u model.User
	if err := s.db.WithContext(ctx).First(&u, "id = ?", userID).Error; err != nil {
		return "", ErrSessionNotFound
	}
	if u.PasswordHash == "" {
		// Still on the default password: that is the current one.
		def := settings.Load(ctx, s.db).DefaultPassword
		if def == "" || subtle.ConstantTimeCompare([]byte(current), []byte(def)) != 1 {
			return "", ErrWrongCurrentPassword
		}
	} else if bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(current)) != nil {
		return "", ErrWrongCurrentPassword
	}
	if def := settings.Load(ctx, s.db).DefaultPassword; def != "" && next == def {
		return "", errors.New("choose a password of your own, not the default one")
	}
	return s.SetPassword(ctx, userID, next, false)
}

// A 256-bit random token needs no slow hash; this only keeps a DB leak from
// being replayable as a live session.
func hashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}
