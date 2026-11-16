/**
 * README inside the install package: Deplao shows the README as plain text during install (Cài ứng dụng → "README của
 * ứng dụng") and the package has no docs/images, so drop every HTML block meant for GitHub (the header with logo, badges
 * and screenshots, screenshot tables, centered images and captions); keep the title and all the text from the intro
 * paragraph on.
 */
export function packageReadme(text) {
  const start = text.search(/^\*\*FinTrack\*\*/m);
  if (start <= 0) return text;
  const title = (/<h1[^>]*>([^<]+)<\/h1>/.exec(text) || [])[1] || 'FinTrack cho Deplao';
  const body = text
    .slice(start)
    .replace(/^<(table|p)\b[^>]*>[\s\S]*?<\/\1>[ \t]*$/gm, '')
    .replace(/^<sub>[\s\S]*?<\/sub>[ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
  return `# ${title.trim()}\n\n${body}`;
}
