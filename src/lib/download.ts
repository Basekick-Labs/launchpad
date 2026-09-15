/**
 * Triggers a browser download. Extracted because `ResultsPanel.svelte` and
 * `logs/LogExportDialog.svelte` each had a byte-identical copy and the panel
 * inspector was about to make a third.
 *
 * Takes BlobParts rather than a string so a large CSV never has to exist as one
 * concatenated value — see `toCsvChunks`.
 */
export function downloadBlob(parts: BlobPart[], filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob(parts, { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
