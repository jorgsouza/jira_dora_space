/**
 * Spinner leve para terminal (sem dependências extra).
 * Usa \r + limpar linha para feedback durante chamadas longas à API.
 */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * @param {string} [initialText]
 * @returns {{ update: (t: string) => void, clear: () => void }}
 */
export function createSpinner(initialText = '') {
  let text = initialText;
  let i = 0;
  const id = setInterval(() => {
    const f = FRAMES[i++ % FRAMES.length];
    process.stdout.write(`\r\x1b[K${f} ${text}`);
  }, 90);

  return {
    update(newText) {
      text = newText;
    },
    clear() {
      clearInterval(id);
      process.stdout.write('\r\x1b[K');
    },
  };
}
