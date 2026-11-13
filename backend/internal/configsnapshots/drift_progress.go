package configsnapshots

import (
	"context"
	"errors"
)

func (s *Service) DriftProgress(ctx context.Context, id string) (int64, int, error) {
	st, e := s.repo.GetState(ctx, id)
	if errors.Is(e, ErrNotFound) {
		return 0, 0, nil
	}
	if e != nil {
		return 0, 0, e
	}
	return st.DriftSequence, len(st.DriftQueue), nil
}
