import { useEffect, useMemo, useState } from "react";
import type {
  BinaryFilter,
  CreatedFilter,
  RoleFilter,
  StatusFilter,
  SysUser,
} from "../types";
import {
  isBinaryFilter,
  isCreatedFilter,
  isRoleFilter,
  isStatusFilter,
  matchesCreatedFilter,
  normalizeRole,
  normalizeStatus,
} from "../utils";

function matchesDateRange(value: string | undefined, from: string, to: string) {
  if (!from && !to) return true;
  if (!value) return false;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return false;
  if (from) {
    const fromTime = new Date(`${from}T00:00:00.000`).getTime();
    if (Number.isFinite(fromTime) && time < fromTime) return false;
  }
  if (to) {
    const toTime = new Date(`${to}T23:59:59.999`).getTime();
    if (Number.isFinite(toTime) && time > toTime) return false;
  }
  return true;
}

export function useUserFilters(users: SysUser[], initialQuery: URLSearchParams) {
  const [searchInput, setSearchInput] = useState(initialQuery.get("q") || "");
  const [searchQuery, setSearchQuery] = useState(initialQuery.get("q") || "");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>(() => {
    const value = initialQuery.get("role");
    return isRoleFilter(value) ? value : "all";
  });
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => {
    const value = initialQuery.get("status");
    return isStatusFilter(value) ? value : "all";
  });
  const [createdFilter, setCreatedFilter] = useState<CreatedFilter>(() => {
    const value = initialQuery.get("created");
    return isCreatedFilter(value) ? value : "all";
  });
  const [createdFrom, setCreatedFrom] = useState(initialQuery.get("createdFrom") || "");
  const [createdTo, setCreatedTo] = useState(initialQuery.get("createdTo") || "");
  const [loginFrom, setLoginFrom] = useState(initialQuery.get("loginFrom") || "");
  const [loginTo, setLoginTo] = useState(initialQuery.get("loginTo") || "");
  const [creatorFilter, setCreatorFilter] = useState(initialQuery.get("createdBy") || "");
  const [lockedFilter, setLockedFilter] = useState<BinaryFilter>(() => {
    const value = initialQuery.get("locked");
    return isBinaryFilter(value) ? value : "all";
  });
  const [neverLoginFilter, setNeverLoginFilter] = useState<BinaryFilter>(() => {
    const value = initialQuery.get("neverLogin");
    return isBinaryFilter(value) ? value : "all";
  });
  const [advancedOpen, setAdvancedOpen] = useState(false);

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
      if (!matchesCreatedFilter(item.createdAt, createdFilter)) return false;
      if (!matchesDateRange(item.createdAt, createdFrom, createdTo)) return false;
      if (!matchesDateRange(item.lastLoginAt, loginFrom, loginTo)) return false;
      if (creatorFilter.trim() && !item.createdBy?.toLowerCase().includes(creatorFilter.trim().toLowerCase())) return false;
      if (lockedFilter !== "all" && (item.locked === true) !== (lockedFilter === "yes")) return false;
      if (neverLoginFilter !== "all" && (!item.lastLoginAt) !== (neverLoginFilter === "yes")) return false;
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
  }, [createdFilter, createdFrom, createdTo, creatorFilter, lockedFilter, loginFrom, loginTo, neverLoginFilter, roleFilter, searchQuery, statusFilter, users]);

  const activeFilterCount = [
    searchQuery.trim() ? 1 : 0,
    roleFilter !== "all" ? 1 : 0,
    statusFilter !== "all" ? 1 : 0,
    createdFilter !== "all" ? 1 : 0,
    createdFrom || createdTo ? 1 : 0,
    loginFrom || loginTo ? 1 : 0,
    creatorFilter.trim() ? 1 : 0,
    lockedFilter !== "all" ? 1 : 0,
    neverLoginFilter !== "all" ? 1 : 0,
  ].reduce((sum, item) => sum + item, 0);

  const clearFilters = () => {
    setSearchInput("");
    setSearchQuery("");
    setRoleFilter("all");
    setStatusFilter("all");
    setCreatedFilter("all");
    setCreatedFrom("");
    setCreatedTo("");
    setLoginFrom("");
    setLoginTo("");
    setCreatorFilter("");
    setLockedFilter("all");
    setNeverLoginFilter("all");
  };

  return {
    searchInput,
    searchQuery,
    updateSearchQuery: setSearchInput,
    roleFilter,
    updateRoleFilter: setRoleFilter,
    statusFilter,
    updateStatusFilter: setStatusFilter,
    createdFilter,
    updateCreatedFilter: setCreatedFilter,
    createdFrom,
    setCreatedFrom,
    createdTo,
    setCreatedTo,
    loginFrom,
    setLoginFrom,
    loginTo,
    setLoginTo,
    creatorFilter,
    setCreatorFilter,
    lockedFilter,
    setLockedFilter,
    neverLoginFilter,
    setNeverLoginFilter,
    advancedOpen,
    setAdvancedOpen,
    activeFilterCount,
    filteredUsers,
    clearFilters,
  };
}
