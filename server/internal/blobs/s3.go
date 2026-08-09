package blobs

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"github.com/plasticparticle/mneme/server/internal/config"
)

// s3Store relays opaque chunks to any S3-compatible store (MinIO/Garage/AWS).
type s3Store struct {
	client *minio.Client
	bucket string
}

func newS3(cfg config.S3Config) (Store, error) {
	u, err := url.Parse(cfg.Endpoint)
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("invalid S3_ENDPOINT %q", cfg.Endpoint)
	}
	client, err := minio.New(u.Host, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: u.Scheme == "https",
	})
	if err != nil {
		return nil, fmt.Errorf("s3 client: %w", err)
	}
	// Self-provision the bucket so a fresh homelab deploy needs no manual mc step.
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	exists, err := client.BucketExists(ctx, cfg.Bucket)
	if err != nil {
		return nil, fmt.Errorf("s3 bucket check: %w", err)
	}
	if !exists {
		if err := client.MakeBucket(ctx, cfg.Bucket, minio.MakeBucketOptions{}); err != nil {
			return nil, fmt.Errorf("s3 bucket create: %w", err)
		}
	}
	return &s3Store{client: client, bucket: cfg.Bucket}, nil
}

func (s *s3Store) Put(ctx context.Context, key string, data []byte) error {
	_, err := s.client.PutObject(ctx, s.bucket, key, bytes.NewReader(data), int64(len(data)),
		minio.PutObjectOptions{ContentType: "application/octet-stream"})
	return err
}

// DeletePrefix lists and removes every object under prefix. Deletion is driven
// by what object storage actually holds, not by the media_blobs index, so
// chunks that were uploaded but never finalized (and therefore have no index
// row) are removed too — that gap is what let ciphertext outlive a vault.
//
// An empty prefix is refused outright: it would enumerate the entire bucket,
// and the only way to reach this code with one is a caller bug that would
// otherwise cross the owner boundary.
func (s *s3Store) DeletePrefix(ctx context.Context, prefix string) (int, error) {
	if prefix == "" {
		return 0, errors.New("blobs: refusing to delete an empty prefix")
	}
	objects := s.client.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{
		Prefix:    prefix,
		Recursive: true,
	})

	// RemoveObjects consumes a channel and reports failures on another, so feed
	// it from a goroutine while draining the error side here.
	keys := make(chan minio.ObjectInfo)
	var listErr error
	count := 0
	go func() {
		defer close(keys)
		for obj := range objects {
			if obj.Err != nil {
				listErr = obj.Err
				return
			}
			count++
			select {
			case keys <- obj:
			case <-ctx.Done():
				return
			}
		}
	}()

	var firstErr error
	for e := range s.client.RemoveObjects(ctx, s.bucket, keys, minio.RemoveObjectsOptions{}) {
		if e.Err != nil && firstErr == nil {
			firstErr = fmt.Errorf("remove %s: %w", e.ObjectName, e.Err)
		}
	}
	if listErr != nil {
		return count, fmt.Errorf("list %s: %w", prefix, listErr)
	}
	return count, firstErr
}

func (s *s3Store) Get(ctx context.Context, key string) ([]byte, error) {
	obj, err := s.client.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	defer obj.Close() //nolint:errcheck // read-only stream
	data, err := io.ReadAll(obj)
	if err != nil {
		var mErr minio.ErrorResponse
		if errors.As(err, &mErr) && mErr.Code == "NoSuchKey" {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return data, nil
}
