/**
 * Handing a file to the user.
 *
 * There is no server to link to, so the file has to be made in the page: a Blob,
 * an object URL, and an anchor that clicks itself. That is the only way a purely
 * static app can produce a download, and it is what makes the export work
 * offline and inside a home screen web app.
 */

/**
 * Downloads `text` as `filename`.
 *
 * The object URL is revoked on the next frame rather than immediately: Safari
 * has historically cancelled the download if the URL disappears in the same
 * task, and a backup that silently does not arrive is worse than a leaked URL.
 */
export function downloadText(filename: string, text: string, type = "application/json"): void {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  // Appended for the sake of the browsers that ignore a click on a detached
  // element; removed again straight away so nothing is left in the layout.
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => URL.revokeObjectURL(url), 0);
}
