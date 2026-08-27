// Package reminders runs the server-side reminder scheduler. It claims due
// reminders and hands them to a dispatcher. Real push delivery (Web Push / APNs /
// FCM) is §10 step 6 — for now the default dispatcher just logs.
package reminders

import (
	"context"
	"log"
	"time"

	"github.com/mneme-blog/mneme/server/internal/store"
)

// Dispatcher delivers a fired reminder. Reminders are generic ("a journal nudge");
// the dispatcher never sees entry content — there isn't any to see.
type Dispatcher interface {
	Dispatch(ctx context.Context, d store.DueReminder) error
}

// LogDispatcher is the placeholder until push transport lands.
type LogDispatcher struct{}

func (LogDispatcher) Dispatch(_ context.Context, d store.DueReminder) error {
	log.Printf("reminder due: owner=%s reminder=%s fire_at=%s", d.OwnerID, d.ReminderID, d.FireAt.UTC().Format(time.RFC3339))
	return nil
}

type Scheduler struct {
	store      *store.Store
	dispatcher Dispatcher
	interval   time.Duration
	batch      int
}

func NewScheduler(st *store.Store, d Dispatcher, interval time.Duration) *Scheduler {
	if d == nil {
		d = LogDispatcher{}
	}
	if interval <= 0 {
		interval = time.Minute
	}
	return &Scheduler{store: st, dispatcher: d, interval: interval, batch: 100}
}

// Run ticks until the context is cancelled.
func (s *Scheduler) Run(ctx context.Context) {
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			s.tick(ctx, now)
		}
	}
}

func (s *Scheduler) tick(ctx context.Context, now time.Time) {
	due, err := s.store.ClaimDueReminders(ctx, now, s.batch)
	if err != nil {
		log.Printf("reminders: claim failed: %v", err)
		return
	}
	for _, d := range due {
		if err := s.dispatcher.Dispatch(ctx, d); err != nil {
			log.Printf("reminders: dispatch failed: %v", err)
		}
	}
}
