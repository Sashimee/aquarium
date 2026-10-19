import type { PhotoController } from './controller';

/** Photo-mode keys work from anywhere on the page except form fields and open dialogs. */
export function bindPhotoKeys(
  target: Pick<Document, 'addEventListener' | 'removeEventListener'>,
  controller: PhotoController,
  win: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): () => void {
  const down = (e: KeyboardEvent) => {
    if (controller.keyDown(e)) e.preventDefault();
  };
  const up = (e: KeyboardEvent) => controller.keyUp(e.key);
  const blur = () => controller.releaseAll();
  target.addEventListener('keydown', down);
  target.addEventListener('keyup', up);
  win.addEventListener('blur', blur);
  return () => {
    target.removeEventListener('keydown', down);
    target.removeEventListener('keyup', up);
    win.removeEventListener('blur', blur);
  };
}
