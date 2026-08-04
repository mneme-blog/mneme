package api

import (
	"net/http"
	"time"
)

// GET /v1/reminders
func (s *Server) handleListReminders(w http.ResponseWriter, r *http.Request) {
	owner := principalOf(r.Context()).OwnerID

	reminders, err := s.store.ListReminders(r.Context(), owner)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list failed")
		return
	}

	type item struct {
		ReminderID string `json:"reminder_id"`
		FireAt     string `json:"fire_at"`
		Dispatched bool   `json:"dispatched"`
	}
	out := make([]item, 0, len(reminders))
	for _, rm := range reminders {
		out = append(out, item{
			ReminderID: rm.ReminderID,
			FireAt:     rm.FireAt.UTC().Format(time.RFC3339),
			Dispatched: rm.Dispatched,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"reminders": out})
}

// PUT /v1/reminders — create or reschedule a reminder. fire_at is cleartext (an
// accepted leak, §3): the scheduler needs it; the entry content stays encrypted.
func (s *Server) handlePutReminder(w http.ResponseWriter, r *http.Request) {
	owner := principalOf(r.Context()).OwnerID

	var req struct {
		ReminderID string `json:"reminder_id"`
		FireAt     string `json:"fire_at"` // RFC3339
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	// Same bound as the oplog's entry_id (sync.go): this is a stored, indexed
	// primary key, and an unvalidated one is free storage for an owner.
	if !recordIDRe.MatchString(req.ReminderID) {
		writeError(w, http.StatusBadRequest, "reminder_id must be 1-128 characters of [A-Za-z0-9_.:-]")
		return
	}
	fireAt, err := time.Parse(time.RFC3339, req.FireAt)
	if err != nil {
		writeError(w, http.StatusBadRequest, "fire_at must be RFC3339")
		return
	}
	if err := s.store.UpsertReminder(r.Context(), owner, req.ReminderID, fireAt); err != nil {
		writeError(w, http.StatusInternalServerError, "save failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"reminder_id": req.ReminderID})
}

// DELETE /v1/reminders/{id}
func (s *Server) handleDeleteReminder(w http.ResponseWriter, r *http.Request) {
	owner := principalOf(r.Context()).OwnerID
	id := r.PathValue("id")

	ok, err := s.store.DeleteReminder(r.Context(), owner, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "delete failed")
		return
	}
	if !ok {
		writeError(w, http.StatusNotFound, "no such reminder")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
