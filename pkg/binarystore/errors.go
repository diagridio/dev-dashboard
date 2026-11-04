package binarystore

// Kind classifies a read failure so the HTTP layer can map it to a status.
type Kind int

const (
	KindAppNotFound        Kind = iota + 1 // 404
	KindSidecarUnreachable                 // 503 (also GRPCPort == 0)
	KindStoreNotLoaded                     // 400
	KindFileNotFound                       // 404 (gRPC NotFound)
	KindInvalid                            // 400 (gRPC InvalidArgument)
	KindUnsupported                        // 400 (gRPC Unimplemented)
	KindTooLarge                           // 413
	KindUpstream                           // 503 if Unavailable, else 502
)

// Error is the typed failure returned by Service.Read.
type Error struct {
	Kind Kind
	Msg  string
	// Size is the known payload size (KindTooLarge only).
	Size int64
	// Unavailable is true for gRPC Unavailable (KindUpstream only).
	Unavailable bool
}

func (e *Error) Error() string { return e.Msg }
