import { useEffect, useState, type AnchorHTMLAttributes } from "react";

// Keep workspaces mounted when switching screens so in-progress work stays visible on return.

export function navigate(to: string) {
  if (to !== location.pathname + location.search) history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useLocation() {
  const read = () => ({ path: location.pathname, search: location.search });
  const [value, setValue] = useState(read);
  useEffect(() => {
    const onChange = () => setValue(read());
    window.addEventListener("popstate", onChange);
    return () => window.removeEventListener("popstate", onChange);
  }, []);
  return value;
}

export function Link({ to, onClick, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      {...rest}
      href={to}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(to);
      }}
    />
  );
}
