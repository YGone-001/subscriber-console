import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { normalizePageSize } from "../utils";

export function useUserPagination<T>(items: T[], initialQuery: URLSearchParams, resetKey: string) {
  const [pageState, setPageState] = useState(() => ({
    resetKey,
    page: Math.max(1, Number(initialQuery.get("page")) || 1),
  }));
  const [pageSize, setPageSize] = useState(() => normalizePageSize(initialQuery.get("pageSize")));
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const requestedPage = pageState.resetKey === resetKey ? pageState.page : 1;
  const safePage = Math.min(requestedPage, pageCount);
  const pagedItems = useMemo(
    () => items.slice((safePage - 1) * pageSize, safePage * pageSize),
    [items, pageSize, safePage],
  );

  const setPage: Dispatch<SetStateAction<number>> = useCallback((nextPage) => {
    setPageState((current) => {
      const currentPage = current.resetKey === resetKey ? current.page : 1;
      const page = typeof nextPage === "function" ? nextPage(currentPage) : nextPage;
      return { resetKey, page: Math.max(1, page) };
    });
  }, [resetKey]);

  return {
    page: safePage,
    setPage,
    pageSize,
    setPageSize,
    pageCount,
    safePage,
    pagedItems,
  };
}
