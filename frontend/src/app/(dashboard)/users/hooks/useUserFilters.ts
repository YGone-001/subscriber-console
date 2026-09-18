import { useEffect, useMemo, useState } from "react";
import type { RoleFilter, StatusFilter, SysUser } from "../types";
import { isRoleFilter, isStatusFilter, normalizeRole, normalizeStatus } from "../utils";

export function useUserFilters(users: SysUser[], initialQuery: URLSearchParams) {
  const initialSearch = initialQuery.get("q") || "";
  const [searchInput, setSearchInput] = useState(initialSearch);
  const [searchQuery, setSearchQuery] = useState(initialSearch);
  const [roleFilter, setRoleFilter] = useState<RoleFilter>(() => {
    const value = initialQuery.get("role");
    return isRoleFilter(value) ? value : "all";
  });
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => {
    const value = initialQuery.get("status");
    return isStatusFilter(value) ? value : "all";
  });

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchQuery(searchInput), 260);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const filteredUsers = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase();
    return users.filter((item) => {
      const role = normalizeRole(item.role);
      const status = normalizeStatus(item.status);
      if (roleFilter !== "all" && role !== roleFilter) return false;
      if (statusFilter !== "all" && status !== statusFilter) return false;
      if (!keyword) return true;
      return [
        item.username,
        item.displayName,
        item.email,
        item.description,
        item.createdBy,
        role,
        status,
      ].filter(Boolean).join(" ").toLowerCase().includes(keyword);
    });
  }, [roleFilter, searchQuery, statusFilter, users]);

  const clearFilters = () => {
    setSearchInput("");
    setSearchQuery("");
    setRoleFilter("all");
    setStatusFilter("all");
  };

  return {
    searchInput,
    searchQuery,
    updateSearchQuery: setSearchInput,
    roleFilter,
    updateRoleFilter: setRoleFilter,
    statusFilter,
    updateStatusFilter: setStatusFilter,
    filteredUsers,
    clearFilters,
  };
}
