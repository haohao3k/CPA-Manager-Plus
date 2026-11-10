package adminauth

import (
	"context"
	"strings"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/security"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

type ResetAdminKeyResult struct {
	AdminKey  string
	Generated bool
	Unlocked  bool
}

func ResetAdminKey(ctx context.Context, st *store.Store, adminKey string) (ResetAdminKeyResult, error) {
	adminKey = strings.TrimSpace(adminKey)
	generated := false
	source := "cli"
	if adminKey == "" {
		value, err := security.GenerateAdminKey()
		if err != nil {
			return ResetAdminKeyResult{}, err
		}
		adminKey = value
		generated = true
		source = "cli-generated"
	}

	credential, err := security.NewAdminCredential(adminKey, source)
	if err != nil {
		return ResetAdminKeyResult{}, err
	}
	if existing, ok, err := st.LoadAdminCredential(ctx); err != nil {
		return ResetAdminKeyResult{}, err
	} else if ok && existing.CreatedAtMS > 0 {
		credential.CreatedAtMS = existing.CreatedAtMS
	}
	credential.RotatedAtMS = time.Now().UnixMilli()
	credential.FailedAttempts = 0
	credential.LockedUntilMS = 0
	if err := st.SaveAdminCredential(ctx, credential); err != nil {
		return ResetAdminKeyResult{}, err
	}
	if state, ok, err := st.LoadBootstrapState(ctx); err == nil && ok && !state.AdminReady {
		state.AdminReady = true
		_ = st.SaveBootstrapState(ctx, state)
	}
	return ResetAdminKeyResult{AdminKey: adminKey, Generated: generated, Unlocked: true}, nil
}
