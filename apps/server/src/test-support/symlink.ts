export function isUnsupportedSymlinkError(error: unknown): boolean {
  return (
    error instanceof Error
    && 'code' in error
    && ['EACCES', 'ENOTSUP', 'EPERM'].includes(String(error.code))
  );
}
