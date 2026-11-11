import { useEffect } from 'react';

const APP_NAME = 'SnapAttend';

/**
 * Per-page document title: `"Sessions · SnapAttend"`, or plain `"SnapAttend"` when
 * `title` is falsy (a page still loading its subject name should not render
 * "undefined · SnapAttend").
 *
 * The previous title is restored on unmount so a standalone page — /scan, /enroll,
 * the auth screens — hands the tab back unchanged when the user navigates away.
 */
export function useDocumentTitle(title) {
  useEffect(() => {
    const previous = document.title;
    document.title = title ? `${title} · ${APP_NAME}` : APP_NAME;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

export default useDocumentTitle;
