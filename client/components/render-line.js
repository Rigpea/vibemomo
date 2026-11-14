// The Audio panel's one line about a rendered file, from the server's answer to the render route.
// A file with no sound in it is still saved, but the line is a warning.
// Each value holds together with non-breaking spaces, so the line can only break at a separator.
const size = (bytes) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);
const whole = (value) => value.replaceAll(' ', ' ');

// `age` is the file's relative time, in the words of ago() in ui.js; the caller keeps it fresh, and without it the line ends at the size.
export function renderLine({ path, bytes, seconds, peak }, age) {
  const silent = !(peak > 0);
  const level = silent ? 'silent' : `peak ${Math.round(20 * Math.log10(peak))} dB`;
  const values = [`Saved ${path}`, `${seconds.toFixed(2)} s`, level, size(bytes)];
  if (age) values.push(age);
  return { text: values.map(whole).join(' · '), warn: silent };
}
