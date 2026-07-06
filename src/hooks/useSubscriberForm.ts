import { useState, useEffect } from "react";
import { parseBytes, formatBytes, parseSeconds, formatSeconds } from "@/lib/unitParser";

export function useSubscriberForm(imsi: string | null, t: any, onClose: () => void, onRefresh: () => void) {
  const [isEditing, setIsEditing] = useState(!imsi);
  const [isLoading, setIsLoading] = useState(!!imsi);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [newlyAddedSliceIndex, setNewlyAddedSliceIndex] = useState<number | null>(null);
  const [inputImsi, setInputImsi] = useState(imsi || "");
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [expandedSlices, setExpandedSlices] = useState<number[]>([0]);
  const [isAccessRestrictionsExpanded, setIsAccessRestrictionsExpanded] = useState(false);

  const [auth4GData, setAuth4GData] = useState({ k: "", opValue: "", sqn: 0, amf: "8000" });
  const [usimType, setUsimType] = useState<"opc" | "op">("opc");
  const [baseSub4G, setBaseSub4G] = useState<any>({});
  const [msisdn, setMsisdn] = useState("");
  const [ueAmbr, setUeAmbr] = useState({ downlink: { unit: 3, value: 1 }, uplink: { unit: 3, value: 1 } });

  const [slices, setSlices] = useState<any[]>([]);
  const [accessRestriction, setAccessRestriction] = useState<number>(0);
  const [profileList, setProfileList] = useState<any[]>([]);
  const [ratingList, setRatingList] = useState<any[]>([]);
  const [selectedRatingGroupId, setSelectedRatingGroupId] = useState<string>("");

  const [ocsPlmn, setOcsPlmn] = useState("45400");
  const [ocsTrafficTotalStr, setOcsTrafficTotalStr] = useState("10 GB");
  const [ocsTrafficBalanceStr, setOcsTrafficBalanceStr] = useState("10 GB");
  const [ocsWithholdStr, setOcsWithholdStr] = useState("10 MB");
  const [ocsWithholdingResidueStr, setOcsWithholdingResidueStr] = useState("8 MB");
  const [ocsWithholdingTimeStr, setOcsWithholdingTimeStr] = useState("60m");
  const [ocsCurrency, setOcsCurrency] = useState("USD");
  const [ocsBalance, setOcsBalance] = useState("10000");

  const [plmnDb, setPlmnDb] = useState<any[]>([]);

  const isValidIpv4 = (value: string) => {
    const parts = value.split(".");
    if (parts.length !== 4) return false;
    return parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
  };

  const resolvePlmnFromImsi = (value: string) => {
    if (!value || value.length < 5) return null;
    const prefix6 = value.substring(0, 6);
    const prefix5 = value.substring(0, 5);
    if (plmnDb.length > 0) {
      const matched6 = plmnDb.find(item => `${item.mcc}${item.mnc}` === prefix6);
      if (matched6) return prefix6;
      const matched5 = plmnDb.find(item => `${item.mcc}${item.mnc}` === prefix5);
      if (matched5) return prefix5;
    }
    return prefix5;
  };

  const updatePlmnByImsi = (currentImsi: string) => {
    const plmn = resolvePlmnFromImsi(currentImsi);
    if (plmn) {
      setOcsPlmn(plmn);
      return true;
    }
    return false;
  };

  useEffect(() => {
    const fetchProfileList = async () => {
      try {
        const res = await fetch('/api/profiles');
        const data = await res.json();
        setProfileList(data.profiles || []);
      } catch (e) {}
    };
    const fetchRatingList = async () => {
      try {
        const res = await fetch('/api/ratings');
        const data = await res.json();
        setRatingList(data.ratings || []);
      } catch (e) {}
    };
    const fetchPlmnDb = async () => {
      try {
        const res = await fetch('/data/mcc-mnc-table.json');
        const data = await res.json();
        setPlmnDb(data || []);
      } catch (e) {}
    };
    fetchProfileList();
    fetchRatingList();
    fetchPlmnDb();
  }, []);

  useEffect(() => {
    const targetImsi = imsi || inputImsi;
    updatePlmnByImsi(targetImsi);
  }, [imsi, inputImsi, plmnDb]);

  const loadFromProfile = async (profileName: string) => {
    if (!profileName) return;
    try {
      const res = await fetch(`/api/profiles/${profileName}`);
      const data = await res.json();
      if (data.profile) {
        const p = data.profile;
        if (p.auth) {
          if (p.auth.op) setUsimType("op");
          else if (p.auth.opc) setUsimType("opc");
          setAuth4GData(prev => ({
            ...prev,
            k: p.auth.k || prev.k,
            opValue: p.auth.opc || p.auth.op || prev.opValue,
            amf: p.auth.amf || prev.amf
          }));
        }
        if (p.ambr) setUeAmbr(p.ambr);
        if (Array.isArray(p.msisdnList) && p.msisdnList[0]?.msisdn !== undefined) {
          setMsisdn(String(p.msisdnList[0].msisdn));
        }
        if (Array.isArray(p.sliceList)) setSlices(JSON.parse(JSON.stringify(p.sliceList)));
        if (p.ocsDefaults) {
          const hasImsi = !!(imsi || inputImsi);
          if (!hasImsi) setOcsPlmn(p.ocsDefaults.plmn || ocsPlmn);
          if (p.ocsDefaults.trafficTotal !== undefined) setOcsTrafficTotalStr(formatBytes(p.ocsDefaults.trafficTotal));
          else if (p.ocsDefaults.trafficBalance !== undefined) setOcsTrafficTotalStr(formatBytes(p.ocsDefaults.trafficBalance));
          if (p.ocsDefaults.trafficBalance !== undefined) setOcsTrafficBalanceStr(formatBytes(p.ocsDefaults.trafficBalance));
          setOcsCurrency(p.ocsDefaults.currency || ocsCurrency);
          setOcsBalance(p.ocsDefaults.balance || ocsBalance);
          if (p.ocsDefaults.withhold !== undefined) setOcsWithholdStr(formatBytes(p.ocsDefaults.withhold));
          if (p.ocsDefaults.withholdingResidue !== undefined) setOcsWithholdingResidueStr(formatBytes(p.ocsDefaults.withholdingResidue));
          if (p.ocsDefaults.withholdingTime !== undefined) setOcsWithholdingTimeStr(formatSeconds(p.ocsDefaults.withholdingTime));
          if (p.ocsDefaults.ratingGroupId) setSelectedRatingGroupId(String(p.ocsDefaults.ratingGroupId));
        }
        const targetImsi = imsi || inputImsi;
        updatePlmnByImsi(targetImsi);
        setToastMessage(t("sub_toast_profile", { name: profileName }));
        setTimeout(() => setToastMessage(null), 3000);
      }
    } catch (e) {
      setError('Failed to load profile template.');
    }
  };

  useEffect(() => {
    if (!imsi) return;
    const fetchData = async () => {
      try {
        const res = await fetch(`/api/subscribers/${imsi}?t=${new Date().getTime()}`);
        if (!res.ok) throw new Error("Failed to fetch");
        const data = await res.json();

        if (data.sub4G) {
          setBaseSub4G(data.sub4G);
          if (Array.isArray(data.sub4G.msisdnList) && data.sub4G.msisdnList[0]?.msisdn !== undefined) {
            setMsisdn(String(data.sub4G.msisdnList[0].msisdn));
          }
          if (data.sub4G.ambr) setUeAmbr(data.sub4G.ambr);
          if (data.sub4G.sliceList && Array.isArray(data.sub4G.sliceList)) {
            setSlices(data.sub4G.sliceList);
          }
          if (data.sub4G.access_restriction_data !== undefined) {
            setAccessRestriction(Number(data.sub4G.access_restriction_data));
          }
        }
        if (data.auth4G) {
          const detectedType = data.auth4G.op ? "op" : "opc";
          setUsimType(detectedType);
          setAuth4GData({
            k: data.auth4G.k || "",
            opValue: data.auth4G.opc || data.auth4G.op || "",
            sqn: data.auth4G.sqn || 0,
            amf: data.auth4G.amf || "8000"
          });
        }
        if (data.ocsTraffic) {
          setOcsPlmn(data.ocsTraffic.plmn || "45400");
          if (data.ocsTraffic.traffic_total !== undefined) {
             setOcsTrafficTotalStr(formatBytes(data.ocsTraffic.traffic_total));
          } else {
             setOcsTrafficTotalStr(formatBytes(data.ocsTraffic.traffic_balance || 0));
          }
          if (data.ocsTraffic.traffic_balance !== undefined) setOcsTrafficBalanceStr(formatBytes(data.ocsTraffic.traffic_balance));
        }
        if (data.ocsImsi) {
          if (data.ocsImsi.withhold !== undefined) setOcsWithholdStr(formatBytes(data.ocsImsi.withhold));
          if (data.ocsImsi.withholding_residue !== undefined) setOcsWithholdingResidueStr(formatBytes(data.ocsImsi.withholding_residue));
          if (data.ocsImsi.withholding_time !== undefined) setOcsWithholdingTimeStr(formatSeconds(data.ocsImsi.withholding_time));
        }
        if (data.ocsImsiSet && data.ocsImsiSet.rates_map) {
          const plmnKey = Object.keys(data.ocsImsiSet.rates_map)[0];
          if (plmnKey) setSelectedRatingGroupId(String(data.ocsImsiSet.rates_map[plmnKey]));
        }
      } catch (err) {
        setError(t("sub_err_load"));
      } finally {
        setIsLoading(false);
      }
    };
    fetchData();
  }, [imsi]);

  const handleDelete = async () => {
    if (!imsi) return;
    if (!confirm(t("sub_del_confirm", { imsi }))) return;
    try {
      const res = await fetch(`/api/subscribers/${imsi}`, { method: "DELETE" });
      if (res.ok) {
        onRefresh();
        onClose();
      }
    } catch (e) {
      setError(t("sub_err_delete"));
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const targetImsi = imsi || inputImsi;
      if (!targetImsi) throw new Error(t("sub_err_imsi_req"));
      if (!/^\d{15}$/.test(targetImsi)) throw new Error(t("sub_err_imsi_15"));
      if (!/^\d+$/.test(msisdn)) throw new Error(t("sub_err_msisdn"));

      const sanitizedSlices = (Array.isArray(slices) ? slices : []).map((slice) => ({
        ...slice,
        session_list: (Array.isArray(slice.session_list) ? slice.session_list : []).map((session: any) => {
          const pgwIpv4 = session?.pgwIpv4?.trim() || "";
          if (pgwIpv4 && !isValidIpv4(pgwIpv4)) {
            throw new Error(`Invalid PGW IPv4 format in session ${session?.name || "unknown"}.`);
          }
          return {
            ...session,
            pgwIpv4,
            pgwIpv6: session?.pgwIpv6?.trim() || "",
          };
        }),
      }));

      if (!imsi) {
        await fetch("/api/subscribers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imsi: targetImsi }),
        });
      }

      const finalSub4G = {
        ...baseSub4G,
        ambr: ueAmbr,
        sliceList: sanitizedSlices,
        access_restriction_data: accessRestriction,
        msisdnList: [{ msisdn }],
      };

      const authPayload: any = { k: auth4GData.k, sqn: Number(auth4GData.sqn), amf: auth4GData.amf };
      authPayload[usimType] = auth4GData.opValue;

      const ocsTrafficPayload = {
        traffic_total: parseBytes(ocsTrafficTotalStr),
        traffic_balance: parseBytes(ocsTrafficBalanceStr),
        imsi: targetImsi,
        plmn: ocsPlmn
      };

      const ocsImsiPayload = {
        account_id: targetImsi,
        imsi: targetImsi,
        withhold: parseBytes(ocsWithholdStr),
        withholding_residue: parseBytes(ocsWithholdingResidueStr),
        withholding_time: parseSeconds(ocsWithholdingTimeStr)
      };

      const ocsAccountPayload = {
        account_id: targetImsi,
        balance: String(ocsBalance),
        currency: ocsCurrency
      };

      let ocsImsiSetPayload: any = undefined;
      if (selectedRatingGroupId) {
        ocsImsiSetPayload = {
          rates_map: { [ocsPlmn]: Number(selectedRatingGroupId) },
          imsi: targetImsi
        };
      }

      const payload: any = {
        sub4G: finalSub4G,
        auth4G: authPayload,
        ocsTraffic: ocsTrafficPayload,
        ocsImsi: ocsImsiPayload,
        ocsAccount: ocsAccountPayload
      };
      if (ocsImsiSetPayload) payload.ocsImsiSet = ocsImsiSetPayload;

      const res = await fetch(`/api/subscribers/${targetImsi}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error("Failed to save");

      onRefresh();
      onClose();
    } catch (err: any) {
      setError(err.message || t("sub_err_save"));
    } finally {
      setIsSaving(false);
    }
  };

  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const addSlice = () => {
    const currentMaxSd = slices.reduce((max: number, slice: any) => {
      const parsed = parseInt(String(slice?.sd ?? "0"), 10);
      return Number.isFinite(parsed) ? Math.max(max, parsed) : max;
    }, 0);
    const nextSd = String(Math.max(1, currentMaxSd + 1)).padStart(6, "0");
    const newIdx = slices.length;
    setSlices([...slices, { default_indicator: slices.length === 0, sd: nextSd, sst: 1, session_list: [{
      ambr: { downlink: { unit: 1, value: 100 }, uplink: { unit: 1, value: 100 } },
      name: "internet", pcc_rule: [], pgwIpv4: "", pgwIpv6: "",
      qos: { _5qi: 9, index: 0, arp: { preemptCap: "NOT_PREEMPT", preemptVuln: "NOT_PREEMPTABLE", priorityLevel: 8 } },
      type: 1
    }] }]);
    setNewlyAddedSliceIndex(newIdx);
    setTimeout(() => setNewlyAddedSliceIndex(null), 1500);
    setTimeout(() => scrollTo(`slice-card-${newIdx}`), 100);
  };

  const removeSlice = (sliceIndex: number) => {
    const newSlices = [...slices];
    newSlices.splice(sliceIndex, 1);
    setSlices(newSlices);
  };

  const handleSliceChange = (idx: number, newSlice: any) => {
    const newSlices = [...slices];
    newSlices[idx] = newSlice;
    setSlices(newSlices);
  };

  return {
    state: {
      isEditing, isLoading, isSaving, error, newlyAddedSliceIndex, inputImsi, toastMessage,
      expandedSlices, isAccessRestrictionsExpanded, auth4GData, usimType, msisdn, ueAmbr, slices,
      accessRestriction, profileList, ratingList, selectedRatingGroupId, ocsPlmn, ocsTrafficTotalStr,
      ocsTrafficBalanceStr, ocsWithholdStr, ocsWithholdingResidueStr, ocsWithholdingTimeStr,
      ocsCurrency, ocsBalance
    },
    actions: {
      setIsEditing, setInputImsi, setMsisdn, loadFromProfile, setSelectedRatingGroupId, setAuth4GData,
      setUsimType, setUeAmbr, setIsAccessRestrictionsExpanded, setAccessRestriction, setOcsTrafficTotalStr,
      setOcsTrafficBalanceStr, setOcsCurrency, setOcsBalance, setOcsWithholdStr, setOcsWithholdingResidueStr,
      setOcsWithholdingTimeStr, addSlice, handleSliceChange, removeSlice, setExpandedSlices, handleDelete,
      handleSave, scrollTo
    }
  };
}
