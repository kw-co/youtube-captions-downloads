export function sanitizeFilename(name: string): string {
  // Replace invalid characters for file names with an underscore
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'Untitled_Video';
}
