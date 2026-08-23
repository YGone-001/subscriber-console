import { useState } from "react";
import type { SortDirection, SortKey, SysUser } from "../types";
import { isSortDirection, isSortKey, normalizeStatus } from "../utils";

export function sortUsers(items: SysUser[], sortKey: SortKey, sortDirection: SortDirection) {
  const direction = sortDirection === "asc" ? 1 : -1;
  return [...items].sort((left, right) => {
    if (sortKey === "createdAt" || sortKey === "lastLoginAt") {
      const leftTime = left[sortKey] ? new Date(left[sortKey]).getTime() : 0;
      const rightTime = right[sortKey] ? new Date(right[sortKey]).getTime() : 0;
      return (leftTime - rightTime) * direction;
    }
    if (sortKey === "status") {
      return normalizeStatus(left.status).localeCompare(normalizeStatus(right.status)) * direction;
    }
    return left.username.localeCompare(right.username) * direction;
  });
}

export function useUserSort(initialQuery: URLSearchParams) {
  const [sortKey, setSortKey] = useState<SortKey>(() => {
    const value = initialQuery.get("sort");
    return isSortKey(value) ? value : "createdAt";
  });
  const [sortDirection, setSortDirection] = useState<SortDirection>(() => {
    const value = initialQuery.get("dir");
    return isSortDirection(value) ? value : "desc";
  });

  const toggleSort = (nextKey: SortKey) => {
    if (sortKey === nextKey) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }
    setSortKey(nextKey);
    setSortDirection(nextKey === "username" || nextKey === "status" ? "asc" : "desc");
  };

  return {
    sortKey,
    sortDirection,
    toggleSort,
    sortUsers: (items: SysUser[]) => sortUsers(items, sortKey, sortDirection),
  };
}
