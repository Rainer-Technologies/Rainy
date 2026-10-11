//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

// DPAPI: cifra con la clave de la cuenta de Windows que ejecuta el companion.
// Otro usuario del mismo PC, o otro equipo, no puede descifrar el resultado.

var (
	crypt32       = syscall.NewLazyDLL("crypt32.dll")
	kernel32      = syscall.NewLazyDLL("kernel32.dll")
	procProtect   = crypt32.NewProc("CryptProtectData")
	procUnprotect = crypt32.NewProc("CryptUnprotectData")
	procLocalFree = kernel32.NewProc("LocalFree")
)

type dataBlob struct {
	cbData uint32
	pbData *byte
}

func dpapiCall(proc *syscall.LazyProc, in []byte) ([]byte, error) {
	var inBlob dataBlob
	if len(in) > 0 {
		inBlob.cbData = uint32(len(in))
		inBlob.pbData = &in[0]
	}
	var out dataBlob
	r, _, err := proc.Call(uintptr(unsafe.Pointer(&inBlob)), 0, 0, 0, 0, 0, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return nil, err
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(out.pbData)))
	return append([]byte(nil), unsafe.Slice(out.pbData, out.cbData)...), nil
}

func protect(data []byte) ([]byte, error) {
	return dpapiCall(procProtect, data)
}

func unprotect(data []byte) ([]byte, error) {
	return dpapiCall(procUnprotect, data)
}
