//go:build e2e

// Package e2e_test holds real end-to-end discovery tests.
//
// This file exists only to pin go/build's package-name resolution. That
// scanner reads directory entries in sorted filename order and, for the
// first _test.go file it encounters, mistakenly treats it as an external
// test file (stripping the "_test" suffix) whenever no plain .go file has
// established the package name yet — see the TODO(#45999) note in
// go/build's source. Because harness.go is the package's only plain file
// and test filenames such as compose_e2e_test.go sort before it
// alphabetically ('c' < 'h'), that bug fires here and the build fails with
// "found packages e2e (compose_e2e_test.go) and e2e_test (harness.go)".
//
// Naming this file with a leading digit guarantees it sorts first (digits
// precede letters in ASCII), so the package name is pinned to "e2e_test"
// before any _test.go file is read, regardless of what future test files
// are named.
package e2e_test
