Both conflicts resolved:

- **`page.tsx`**: Kept HEAD's server component pattern (metadata export + JSON-LD + `<DownloadClient />`). The feature branch was duplicating the entire client component into `page.tsx`, which would break Next.js since you can't use `useState`/`useEffect` alongside `export const metadata` in a server component. The actual UI already lives in `DownloadClient.tsx`.

- **`Nav.tsx`**: Kept the feature branch's full Nav component. HEAD's side was just a placeholder marker ("File resolved and staged") with no actual component code.
