package api

import (
	"encoding/json"
	"log"
	"net/http"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("write json: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// decodeJSON reads a JSON body, rejecting unknown fields and oversized payloads.
//
// The decoder error is logged, never returned. encoding/json errors name the
// offending field and byte offset, and with DisallowUnknownFields they also
// confirm which field names a handler accepts — an unauthenticated caller could
// map the whole request schema by feeding it guesses. The caller gets one
// generic message; the operator gets the detail.
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 32<<20) // 32 MiB ceiling for an encrypted blob batch
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		log.Printf("decode %s %s: %v", r.Method, r.URL.Path, err)
		writeError(w, http.StatusBadRequest, "invalid request body")
		return false
	}
	return true
}
