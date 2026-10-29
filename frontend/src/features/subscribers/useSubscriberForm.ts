/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/hooks/useSubscriberForm.ts
 * Adaptations: "use client" dropped; `@/` aliases and CSS-module imports repointed for the Vite runtime.
 */
import { useCallback, useMemo, useState, useEffect, useRef } from "react";
import { parseBytes, formatBytes, parseSeconds, formatSeconds, parseEvents, formatEvents } from '../../lib/unitParser';
import { sessionQosPreset } from '../../lib/imsQosPresets.js';
import { getJson, getJsonWithSignal } from '../../lib/api/read-client';
import { deleteJson, MutationApiError, postJson, putJson } from '../../lib/api/mutation-client';
import { buildSubscriberCreateRequest } from './mutation-contract';
import { isRecommendedOnboardingPlan } from './onboarding-template';
import type { Auth4GData } from '../../types/subscriber';
import { resolveUsimType } from '../../types/credential';

type ApiRecord = Record<string, any>;

function mutationErrorBody(error: unknown): ApiRecord {
  return error instanceof MutationApiError && error.body && typeof error.body === 'object'
    ? error.body as ApiRecord
    : {};
}

type TariffPlanOption = {
  plan_id: string;
  name?: string;
  description?: string;
  status?: string;
  validity_time?: number;
  volume_threshold?: number;
  rules?: any[];
};

const resolvePlmnFromRecords = (records: any[], value: string) => {
  if (!value || value.length < 5) return null;
  const prefix6 = value.substring(0, 6);
  const prefix5 = value.substring(0, 5);
  if (records.length > 0) {
    const matched6 = records.find(item => `${item.mcc}${item.mnc}` === prefix6);
    if (matched6) return prefix6;
    const matched5 = records.find(item => `${item.mcc}${item.mnc}` === prefix5);
    if (matched5) return prefix5;
  }
  return prefix5;
};

export function useSubscriberForm(imsi: string | null, t: any, onClose: () => void, onRefresh: () => void, onSaved?: (imsi: string, created: boolean) => void) {
  const [isEditing, setIsEditing] = useState(!imsi);
  /* Bumped to re-read the record after a draft is discarded, so the form keeps
   * showing stored values instead of the edits that were just abandoned. */
  const [reloadToken, setReloadToken] = useState(0);
  const [isLoading, setIsLoading] = useState(!!imsi);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [newlyAddedSliceIndex, setNewlyAddedSliceIndex] = useState<number | null>(null);
  const [inputImsi, setInputImsi] = useState(imsi || "");
  const [inputImsiExists, setInputImsiExists] = useState(false);
  const [isCheckingInputImsi, setIsCheckingInputImsi] = useState(false);
  const [inputMsisdnExists, setInputMsisdnExists] = useState(false);
  const [isCheckingInputMsisdn, setIsCheckingInputMsisdn] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [expandedSlices, setExpandedSlices] = useState<number[]>([0]);
  const [isAccessRestrictionsExpanded, setIsAccessRestrictionsExpanded] = useState(false);

  const [auth4GData, setAuth4GData] = useState<Auth4GData>({ k: "", opValue: "", sqn: 0, amf: "8000" });
  const [usimType, setUsimType] = useState<"opc" | "op">("opc");
  const [baseSub4G, setBaseSub4G] = useState<any>({});
  const [msisdn, setMsisdn] = useState("");
  /* The template this record was provisioned from, as the service reports it.
   * The detail surface renders it instead of guessing from the draft. */
  const [profileBinding, setProfileBinding] = useState("");
  const [ueAmbr, setUeAmbr] = useState({ downlink: { unit: 3, value: 1 }, uplink: { unit: 3, value: 1 } });
  const [hasUeAmbr, setHasUeAmbr] = useState(!imsi);

  const [slices, setSlices] = useState<any[]>([]);
  const [accessRestriction, setAccessRestriction] = useState<number>(0);
  const [profileList, setProfileList] = useState<any[]>([]);
  /* Whether the template catalog has answered, so an unresolved binding is not
   * reported as a deleted template while the list is still loading. */
  const [profilesReady, setProfilesReady] = useState(false);
  /* The template the operator picked for this create. It travels on the create
   * request so the service records the binding at the same time the record is
   * born; the follow-up content update never rewrites it. */
  const [selectedProfileName, setSelectedProfileName] = useState("");
  const [ratingList, setRatingList] = useState<any[]>([]);
  const [tariffPlanList, setTariffPlanList] = useState<TariffPlanOption[]>([]);
  const [ocsPlanId, setOcsPlanId] = useState("");
  const [ocsPlanStatus, setOcsPlanStatus] = useState("");
  const [ocsContractStatus, setOcsContractStatus] = useState("");
  const [hasOcsContract, setHasOcsContract] = useState(false);
  const [hasOcsBalance, setHasOcsBalance] = useState(false);
  const [ocsRules, setOcsRules] = useState<any[]>([]);

  const [ocsPlmn, setOcsPlmn] = useState("");
  const [ocsTrafficTotalStr, setOcsTrafficTotalStr] = useState("");
  const [ocsTrafficBalanceStr, setOcsTrafficBalanceStr] = useState("");
  const [ocsVoiceTotalStr, setOcsVoiceTotalStr] = useState("");
  const [ocsVoiceBalanceStr, setOcsVoiceBalanceStr] = useState("");
  const [ocsSmsTotalStr, setOcsSmsTotalStr] = useState("");
  const [ocsSmsBalanceStr, setOcsSmsBalanceStr] = useState("");
  const [ocsVolumeThreshold, setOcsVolumeThreshold] = useState<number | null>(0);
  const [ocsDataReservedStr, setOcsDataReservedStr] = useState("");
  const initialOcsSignatureRef = useRef<string | null>(null);

  const [plmnDb, setPlmnDb] = useState<any[]>([]);

  const isValidIpv4 = (value: string) => {
    const parts = value.split(".");
    if (parts.length !== 4) return false;
    return parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
  };

  const resolvePlmnFromImsi = useCallback((value: string) => resolvePlmnFromRecords(plmnDb, value), [plmnDb]);

  const updatePlmnByImsi = useCallback((currentImsi: string) => {
    const plmn = resolvePlmnFromImsi(currentImsi);
    if (plmn) {
      setOcsPlmn(plmn);
      return true;
    }
    return false;
  }, [resolvePlmnFromImsi]);

  const handleInputImsiChange = useCallback((value: string) => {
    const nextImsi = value.replace(/\D/g, "");
    setInputImsi(nextImsi);
    setInputImsiExists(false);
    updatePlmnByImsi(nextImsi);
  }, [updatePlmnByImsi]);

  const handleMsisdnChange = useCallback((value: string) => {
    setMsisdn(value.replace(/\D/g, ""));
    setInputMsisdnExists(false);
  }, []);

  useEffect(() => {
    if (imsi) return;
    if (!/^\d{15}$/.test(inputImsi)) {
      setInputImsiExists(false);
      setIsCheckingInputImsi(false);
      return;
    }

    const controller = new AbortController();
    setIsCheckingInputImsi(true);

    const timer = window.setTimeout(async () => {
      try {
        await getJsonWithSignal(`/api/subscribers/${inputImsi}?t=${new Date().getTime()}`, controller.signal);
        if (controller.signal.aborted) return;
        setInputImsiExists(true);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      } finally {
        if (!controller.signal.aborted) setIsCheckingInputImsi(false);
      }
    }, 250);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [imsi, inputImsi]);

  useEffect(() => {
    if (!msisdn || !/^\d+$/.test(msisdn)) {
      setInputMsisdnExists(false);
      setIsCheckingInputMsisdn(false);
      return;
    }

    const controller = new AbortController();
    setIsCheckingInputMsisdn(true);

    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          msisdn,
          t: String(new Date().getTime()),
        });
        if (imsi) params.set("excludeImsi", imsi);
        const data = await getJsonWithSignal<ApiRecord>(`/api/subscribers?${params.toString()}`, controller.signal);
        if (controller.signal.aborted) return;
        setInputMsisdnExists(!!data.exists);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      } finally {
        if (!controller.signal.aborted) setIsCheckingInputMsisdn(false);
      }
    }, 250);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [imsi, msisdn]);

  useEffect(() => {
    const fetchProfileList = async () => {
      try {
        const data = await getJson<ApiRecord>('/api/profiles');
        setProfileList(data.profiles || []);
      } catch {
    /* Best-effort side effect: a failure here must not block the form. */
  } finally {
        /* The catalog answered (or failed): either way a binding can now be
         * classified instead of being called unresolved forever. */
        setProfilesReady(true);
      }
    };
    const fetchTariffPlanList = async () => {
      try {
        const data = await getJson<ApiRecord>('/api/tariff-plans');
        const plans = Array.isArray(data.plans) ? data.plans : [];
        setTariffPlanList(plans);
        setOcsPlanId((current) => {
          if (current && plans.some((plan: TariffPlanOption) => plan.plan_id === current)) return current;
          /* Existing subscribers must not inherit a plan candidate before the
           * detail response proves a contract exists. */
          if (imsi) return current;
          return plans.find((plan: TariffPlanOption) => isRecommendedOnboardingPlan(plan))?.plan_id
            || plans.find((plan: TariffPlanOption) => (plan.status || "active") === "active")?.plan_id
            || plans[0]?.plan_id
            || current;
        });
      } catch {
    /* Best-effort side effect: a failure here must not block the form. */
  }
    };
    const fetchPlmnDb = async () => {
      try {
        const data = await getJson<any[]>('/data/mcc-mnc-table.json');
        const records = data || [];
        setPlmnDb(records);
      } catch {
    /* Best-effort side effect: a failure here must not block the form. */
  }
    };
    fetchProfileList();
    fetchTariffPlanList();
    fetchPlmnDb();
  }, [imsi]);

  useEffect(() => {
    if (!ocsPlanId) return;
    const controller = new AbortController();

    const fetchPlanContext = async () => {
      try {
        const [planData, ratingsData] = await Promise.all([
          getJsonWithSignal<ApiRecord>(`/api/tariff-plans/${encodeURIComponent(ocsPlanId)}`, controller.signal).catch(() => null),
          getJsonWithSignal<ApiRecord>(`/api/ratings?planId=${encodeURIComponent(ocsPlanId)}`, controller.signal).catch(() => null),
        ]);
        if (controller.signal.aborted) return;

        if (planData) {
          const plan = planData.plan;
          if (plan?.status) setOcsPlanStatus(String(plan.status));
          if (plan?.volume_threshold !== undefined) {
            const threshold = Number(plan.volume_threshold);
            setOcsVolumeThreshold(Number.isFinite(threshold) ? threshold : null);
          }
          if (Array.isArray(plan?.rules)) setOcsRules(plan.rules);
          if (!imsi) {
            const quota = Number(plan?.quota_per_grant);
            if (Number.isFinite(quota) && quota > 0) {
              setOcsTrafficTotalStr(formatBytes(quota));
              setOcsTrafficBalanceStr(formatBytes(quota));
            } else {
              setOcsTrafficTotalStr("");
              setOcsTrafficBalanceStr("");
            }
            const rules = Array.isArray(plan?.rules) ? plan.rules : [];
            const voiceRule = rules.find((rule: any) => rule?.charging_type === "voice_time");
            const smsRule = rules.find((rule: any) => rule?.charging_type === "sms_event" || rule?.unit === "events");
            const voiceQuota = Number(voiceRule?.quota_per_grant);
            const smsQuota = Number(smsRule?.quota_per_grant);
            if (Number.isFinite(voiceQuota) && voiceQuota > 0) {
              setOcsVoiceTotalStr(formatSeconds(voiceQuota));
              setOcsVoiceBalanceStr(formatSeconds(voiceQuota));
            } else {
              setOcsVoiceTotalStr("");
              setOcsVoiceBalanceStr("");
            }
            if (Number.isFinite(smsQuota) && smsQuota > 0) {
              setOcsSmsTotalStr(formatEvents(smsQuota));
              setOcsSmsBalanceStr(formatEvents(smsQuota));
            } else {
              setOcsSmsTotalStr("");
              setOcsSmsBalanceStr("");
            }
          }
        }

        if (ratingsData) {
          setRatingList(ratingsData.ratings || []);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    };

    fetchPlanContext();
    return () => controller.abort();
  }, [ocsPlanId]);

  useEffect(() => {
    const targetImsi = imsi || inputImsi;
    void Promise.resolve().then(() => {
      updatePlmnByImsi(targetImsi);
    });
  }, [imsi, inputImsi, updatePlmnByImsi]);

  const loadFromProfile = async (profileName: string) => {
    if (!profileName) return;
    try {
      const data = await getJson<ApiRecord>(`/api/profiles/${encodeURIComponent(profileName)}`);
      if (data.profile) {
        const p = data.profile;
        setSelectedProfileName(profileName);
        if (p.auth) {
          if (p.auth.op || p.auth.opc || p.auth.credentialState) setUsimType(resolveUsimType(p.auth));
          setAuth4GData(prev => ({
            ...prev,
            k: p.auth.k || prev.k,
            opValue: p.auth.opc || p.auth.op || prev.opValue,
            amf: p.auth.amf || prev.amf
          }));
        }
        if (p.ambr) { setUeAmbr(p.ambr); setHasUeAmbr(true); }
        if (Array.isArray(p.sliceList)) setSlices(JSON.parse(JSON.stringify(p.sliceList)));
        if (p.ocsDefaults) {
          const hasImsi = !!(imsi || inputImsi);
          if (!hasImsi) setOcsPlmn(p.ocsDefaults.plmn || ocsPlmn);
          if (p.ocsDefaults.trafficTotal !== undefined) setOcsTrafficTotalStr(formatBytes(p.ocsDefaults.trafficTotal));
          if (p.ocsDefaults.trafficBalance !== undefined) setOcsTrafficBalanceStr(formatBytes(p.ocsDefaults.trafficBalance));
          if (p.ocsDefaults.voiceTotal !== undefined) setOcsVoiceTotalStr(formatSeconds(Number(p.ocsDefaults.voiceTotal)));
          else if (p.ocsDefaults.voiceBalance !== undefined) setOcsVoiceTotalStr(formatSeconds(Number(p.ocsDefaults.voiceBalance)));
          if (p.ocsDefaults.voiceBalance !== undefined) setOcsVoiceBalanceStr(formatSeconds(Number(p.ocsDefaults.voiceBalance)));
          const smsTotalDefault = p.ocsDefaults.smsTotal ?? p.ocsDefaults.sms_total;
          const smsBalanceDefault = p.ocsDefaults.smsBalance ?? p.ocsDefaults.sms_balance;
          const planDefault = p.ocsDefaults.planId ?? p.ocsDefaults.plan_id;
          if (planDefault !== undefined) setOcsPlanId(String(planDefault));
          if (smsTotalDefault !== undefined) setOcsSmsTotalStr(formatEvents(Number(smsTotalDefault)));
          else if (smsBalanceDefault !== undefined) setOcsSmsTotalStr(formatEvents(Number(smsBalanceDefault)));
          if (smsBalanceDefault !== undefined) setOcsSmsBalanceStr(formatEvents(Number(smsBalanceDefault)));
        }
        const targetImsi = imsi || inputImsi;
        updatePlmnByImsi(targetImsi);
        setToastMessage(t("sub_toast_profile", { name: profileName }));
        setTimeout(() => setToastMessage(null), 3000);
      }
    } catch {
      setError(t("sub_err_profile_load"));
    }
  };

  useEffect(() => {
    if (!imsi) return;
    const fetchData = async () => {
      try {
        const data = await getJson<ApiRecord>(`/api/subscribers/${encodeURIComponent(imsi)}?t=${new Date().getTime()}`);

        if (data.sub4G) {
          setBaseSub4G(data.sub4G);
          setProfileBinding(String(data.sub4G.profile_name ?? ""));
          if (Array.isArray(data.sub4G.msisdnList) && data.sub4G.msisdnList[0]?.msisdn !== undefined) {
            setMsisdn(String(data.sub4G.msisdnList[0].msisdn));
          } else if (data.ocsImsi?.msisdn) {
            setMsisdn(String(data.ocsImsi.msisdn));
          }
          if (data.sub4G.ambr) {
            setUeAmbr(data.sub4G.ambr);
            setHasUeAmbr(true);
          } else {
            setHasUeAmbr(false);
          }
          if (data.sub4G.sliceList && Array.isArray(data.sub4G.sliceList)) {
            setSlices(data.sub4G.sliceList);
          }
          if (data.sub4G.access_restriction_data !== undefined) {
            setAccessRestriction(Number(data.sub4G.access_restriction_data));
          }
        }
        if (data.auth4G) {
          const detectedType = resolveUsimType(data.auth4G);
          setUsimType(detectedType);
          setAuth4GData({
            k: data.auth4G.k || "",
            opValue: data.auth4G.opc || data.auth4G.op || "",
            sqn: typeof data.auth4G.sqn === "number" ? data.auth4G.sqn : null,
            amf: typeof data.auth4G.amf === "string" ? data.auth4G.amf : "",
            credentialState: data.auth4G.credentialState
          });
        } else if (imsi) {
          setAuth4GData({ k: "", opValue: "", sqn: null, amf: "" });
        }
        setHasOcsBalance(Boolean(data.ocsTraffic));
        if (data.ocsTraffic) {
          setOcsPlmn(data.ocsTraffic.plmn ? String(data.ocsTraffic.plmn) : "");
          if (data.ocsTraffic.traffic_total !== undefined) {
             setOcsTrafficTotalStr(formatBytes(data.ocsTraffic.traffic_total));
          } else {
             setOcsTrafficTotalStr("");
          }
          if (data.ocsTraffic.traffic_balance !== undefined) setOcsTrafficBalanceStr(formatBytes(data.ocsTraffic.traffic_balance));
          if (data.ocsTraffic.voice_total !== undefined) setOcsVoiceTotalStr(formatSeconds(Number(data.ocsTraffic.voice_total)));
          if (data.ocsTraffic.voice_balance !== undefined) setOcsVoiceBalanceStr(formatSeconds(Number(data.ocsTraffic.voice_balance)));
          if (data.ocsTraffic.sms_total !== undefined) setOcsSmsTotalStr(formatEvents(Number(data.ocsTraffic.sms_total)));
          if (data.ocsTraffic.sms_balance !== undefined) setOcsSmsBalanceStr(formatEvents(Number(data.ocsTraffic.sms_balance)));
          setOcsDataReservedStr(
            data.ocsTraffic.data_reserved !== undefined
              ? formatBytes(Number(data.ocsTraffic.data_reserved))
              : "",
          );
        } else {
          setOcsDataReservedStr("");
        }
        /* A contract is the authority that a plan exists. Without it, the
         * default tariff plan returned by the read API is not this subscriber's
         * provisioning and must not be rendered as one. */
        const hasContract = Boolean(data.ocsImsi);
        setHasOcsContract(hasContract);
        if (hasContract) {
          if (data.ocsImsi.msisdn) setMsisdn(String(data.ocsImsi.msisdn));
          if (data.ocsImsi.plan_id) setOcsPlanId(String(data.ocsImsi.plan_id));
          setOcsContractStatus(data.ocsImsi.status ? String(data.ocsImsi.status) : "");
          if (data.ocsTariffPlan?.plan_id) setOcsPlanId(String(data.ocsTariffPlan.plan_id));
          if (data.ocsTariffPlan?.status) setOcsPlanStatus(String(data.ocsTariffPlan.status));
          if (data.ocsTariffPlan?.volume_threshold !== undefined) {
            const threshold = Number(data.ocsTariffPlan.volume_threshold);
            setOcsVolumeThreshold(Number.isFinite(threshold) ? threshold : null);
          } else {
            setOcsVolumeThreshold(null);
          }
          if (Array.isArray(data.ocsTariffPlan?.rules)) setOcsRules(data.ocsTariffPlan.rules);
        } else {
          setOcsContractStatus("");
          setOcsPlanId("");
          setOcsPlanStatus("");
          setOcsVolumeThreshold(null);
          setOcsRules([]);
        }
    } catch {
      setError(t("sub_err_load"));
      } finally {
        setIsLoading(false);
      }
    };
    fetchData();
  }, [imsi, t, reloadToken]);

  useEffect(() => {
    if (isLoading || initialOcsSignatureRef.current !== null) return;
    initialOcsSignatureRef.current = JSON.stringify({
      planId: ocsPlanId,
      trafficTotal: ocsTrafficTotalStr,
      trafficBalance: ocsTrafficBalanceStr,
      voiceTotal: ocsVoiceTotalStr,
      voiceBalance: ocsVoiceBalanceStr,
      smsTotal: ocsSmsTotalStr,
      smsBalance: ocsSmsBalanceStr,
    });
  }, [
    isLoading, ocsPlanId, ocsTrafficTotalStr, ocsTrafficBalanceStr,
    ocsVoiceTotalStr, ocsVoiceBalanceStr, ocsSmsTotalStr, ocsSmsBalanceStr,
  ]);

  /* One definition of "unsaved". The surface asks the form instead of rebuilding
   * the fingerprint from the state it was handed, so a field added here cannot
   * silently drop out of the prompt that guards navigation. */
  const draftSignature = useMemo(() => JSON.stringify({
    inputImsi, msisdn, auth4GData, usimType, ueAmbr, slices, accessRestriction, ocsPlanId,
    ocsTrafficTotalStr, ocsTrafficBalanceStr,
    ocsVoiceTotalStr, ocsVoiceBalanceStr,
    ocsSmsTotalStr, ocsSmsBalanceStr,
  }), [
    inputImsi, msisdn, auth4GData, usimType, ueAmbr, slices, accessRestriction, ocsPlanId,
    ocsTrafficTotalStr, ocsTrafficBalanceStr,
    ocsVoiceTotalStr, ocsVoiceBalanceStr,
    ocsSmsTotalStr, ocsSmsBalanceStr,
  ]);
  const draftBaselineRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isLoading && draftBaselineRef.current === null) draftBaselineRef.current = draftSignature;
  }, [isLoading, draftSignature]);
  const hasUnsavedChanges = isEditing
    && draftBaselineRef.current !== null
    && draftBaselineRef.current !== draftSignature;

  const handleDelete = async () => {
    if (!imsi) return;
    try {
      await deleteJson(`/api/subscribers/${encodeURIComponent(imsi)}`);
      onRefresh();
      onClose();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : t("sub_err_delete"));
    }
  };

  /* Leaving edit mode without saving must restore the stored record, not keep the
   * abandoned edits in the fields: a surface that stayed on the page would
   * otherwise re-enter edit mode with changes nobody made. */
  const discardDraft = () => {
    setError(null);
    setToastMessage(null);
    setIsEditing(false);
    draftBaselineRef.current = null;
    if (imsi) setReloadToken((token) => token + 1);
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    /* A create is TWO calls: POST the record, then PUT the full configuration. If the
     * PUT fails the record already exists, so the message must say so rather than
     * report a bare validation error and invite a duplicate retry. Declared outside the
     * try so the catch can still see it. */
    let createdInThisAttempt = false;
    /* Hoisted alongside the flag so the catch can roll the record back. */
    const targetImsi = imsi || inputImsi;
    try {
      if (!targetImsi) throw new Error(t("sub_err_imsi_req"));
      if (!/^\d{15}$/.test(targetImsi)) throw new Error(t("sub_err_imsi_15"));
      if (!imsi && inputImsiExists) throw new Error(t("sub_err_imsi_exists"));
      if (!/^\d+$/.test(msisdn)) throw new Error(t("sub_err_msisdn"));
      if (inputMsisdnExists) throw new Error(t("sub_err_msisdn_exists"));
      if (!imsi && !ocsPlanId) throw new Error(t("sub_err_plan_required"));

      const duplicateParams = new URLSearchParams({ msisdn });
      if (imsi) duplicateParams.set("excludeImsi", imsi);
      try {
        const duplicateData = await getJson<ApiRecord>(`/api/subscribers?${duplicateParams.toString()}`);
        if (duplicateData.exists) {
          setInputMsisdnExists(true);
          throw new Error(t("sub_err_msisdn_exists"));
        }
      } catch (duplicateError) {
        if (duplicateError instanceof Error && duplicateError.message === t("sub_err_msisdn_exists")) throw duplicateError;
      }

      const sanitizedSlices = (Array.isArray(slices) ? slices : []).map((slice) => ({
        ...slice,
        session_list: (Array.isArray(slice.session_list) ? slice.session_list : []).map((session: any) => {
          const pgwIpv4 = session?.pgwIpv4?.trim() || "";
          if (pgwIpv4 && !isValidIpv4(pgwIpv4)) {
            throw new Error(t("sub_err_pgw_ipv4", { session: session?.name || t("unknown") }));
          }
          return {
            ...session,
            pgwIpv4,
            pgwIpv6: session?.pgwIpv6?.trim() || "",
          };
        }),
      }));

      /*
       * Authentication material is provisioned at CREATION. It travels on the POST and must not
       * appear on the follow-up PUT: the service refuses to change authentication material on a
       * record that already exists, so sending it on both calls turned every create into a 422.
       */
      const authPayload: any = { k: auth4GData.k, sqn: Number(auth4GData.sqn), amf: auth4GData.amf };
      authPayload[usimType] = auth4GData.opValue;

      if (!imsi) {
        try {
          await postJson('/api/subscribers', buildSubscriberCreateRequest(targetImsi, {
            planId: ocsPlanId,
            profileName: selectedProfileName || undefined,
            auth4G: authPayload,
          }));
          createdInThisAttempt = true;
        } catch (createError) {
          const createData = mutationErrorBody(createError);
          if ((createError instanceof MutationApiError && createError.status === 409) || createData.error === "Subscriber already exists") {
            setInputImsiExists(true);
            throw new Error(t("sub_err_imsi_exists"));
          }
          if (createData.error === "MSISDN already exists") {
            setInputMsisdnExists(true);
            throw new Error(t("sub_err_msisdn_exists"));
          }
          if (createData.error === "Tariff plan not found") throw new Error(t("tariff_plan_err_not_found"));
          if (createData.error === "Invalid plan_id format") throw new Error(t("tariff_plan_err_id"));
          if (createData.error === "Tariff plan is disabled") throw new Error(t("tariff_plan_err_disabled"));
          /* The server inserted the primary record before OCS provisioning failed.
           * Treat it as created so the shared rollback below reconciles it. */
          if (createError instanceof MutationApiError && createError.code === "SUBSCRIBER_CREATE_PARTIAL_WRITE") {
            createdInThisAttempt = true;
          }
          throw createError;
        }
      }

      const finalSub4G = {
        ...baseSub4G,
        ambr: ueAmbr,
        sliceList: sanitizedSlices,
        access_restriction_data: accessRestriction,
        msisdnList: [{ msisdn }],
      };

      /* Only send OCS fields the operator actually has values for. An empty
       * form on an unprovisioned subscriber must not silently create a default
       * contract or zero out an existing balance. */
      const ocsTrafficPayload: Record<string, any> = {};
      if (ocsPlanId) ocsTrafficPayload.planId = ocsPlanId;
      if (ocsTrafficTotalStr) ocsTrafficPayload.traffic_total = parseBytes(ocsTrafficTotalStr);
      if (ocsTrafficBalanceStr) ocsTrafficPayload.traffic_balance = parseBytes(ocsTrafficBalanceStr);
      if (ocsVoiceTotalStr) ocsTrafficPayload.voice_total = parseSeconds(ocsVoiceTotalStr);
      if (ocsVoiceBalanceStr) ocsTrafficPayload.voice_balance = parseSeconds(ocsVoiceBalanceStr);
      if (ocsSmsTotalStr) ocsTrafficPayload.sms_total = parseEvents(ocsSmsTotalStr);
      if (ocsSmsBalanceStr) ocsTrafficPayload.sms_balance = parseEvents(ocsSmsBalanceStr);

      /*
       * No auth4G here. This request only applies ordinary mutable configuration; authentication
       * material was already provisioned by the POST above and is immutable from this point on.
       */
      const currentOcsSignature = JSON.stringify({
        planId: ocsPlanId,
        trafficTotal: ocsTrafficTotalStr,
        trafficBalance: ocsTrafficBalanceStr,
        voiceTotal: ocsVoiceTotalStr,
        voiceBalance: ocsVoiceBalanceStr,
        smsTotal: ocsSmsTotalStr,
        smsBalance: ocsSmsBalanceStr,
      });
      const ocsDirty = !imsi || initialOcsSignatureRef.current !== currentOcsSignature;

      const payload: any = {
        sub4G: finalSub4G,
      };
      if (ocsDirty && Object.keys(ocsTrafficPayload).length > 0) {
        payload.ocsTraffic = ocsTrafficPayload;
      }

      try {
        await putJson(`/api/subscribers/${encodeURIComponent(targetImsi)}`, payload);
      } catch (updateError) {
        const data = mutationErrorBody(updateError);
        if (data.error === "Tariff plan not found") throw new Error(t("tariff_plan_err_not_found"));
        if (data.error === "Invalid plan_id format") throw new Error(t("tariff_plan_err_id"));
        if (data.error === "Tariff plan is disabled") throw new Error(t("tariff_plan_err_disabled"));
        if (data.error === "MSISDN already exists") {
          setInputMsisdnExists(true);
          throw new Error(t("sub_err_msisdn_exists"));
        }
        /* The governance rule refuses to change auth material on an EXISTING record. This path
         * no longer sends auth4G, so reaching it means a genuine forbidden update attempt rather
         * than the create-time condition the old message described. */
        if (data.code === "SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED") {
          throw new Error(t("sub_err_auth_change_rejected"));
        }

        throw new Error(updateError instanceof Error ? updateError.message : t("sub_err_save"));
      }

      onRefresh();
      if (onSaved) onSaved(targetImsi, !imsi);
      else onClose();
    } catch (err: any) {
      /*
       * Creating is TWO calls: POST the record, then PUT the full configuration. If the
       * PUT fails the record is already in the database, which is why an error could
       * still leave a created subscriber behind.
       *
       * Rolling the record back makes "an error was shown" mean "nothing was created",
       * which is what an operator expects, and it also avoids leaving a subscriber on
       * the service's default authentication key.
       */
      let message = err.message || t("sub_err_save");
      if (createdInThisAttempt) {
        try {
          await deleteJson(`/api/subscribers/${encodeURIComponent(targetImsi)}`);
          message = t("sub_err_create_rolled_back", { error: message });
        } catch (rollbackError) {
          if (rollbackError instanceof MutationApiError && rollbackError.code === "SUBSCRIBER_DELETE_PARTIAL_WRITE") {
            message = t("sub_err_create_rollback_partial", { imsi: targetImsi, error: message });
          } else {
            message = t("sub_err_create_rollback_failed", {
              imsi: targetImsi,
              error: message,
              rollback: rollbackError instanceof Error ? rollbackError.message : t("sub_err_save"),
            });
          }
        }
      }
      setError(message);
      onRefresh();
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
    const preset = sessionQosPreset(9);
    setSlices([...slices, { default_indicator: slices.length === 0, sd: nextSd, sst: 1, session_list: [{
      ambr: preset?.sessionAmbr ?? { downlink: { unit: 3, value: 1 }, uplink: { unit: 3, value: 1 } },
      name: "internet", pcc_rule: [], pgwIpv4: "", pgwIpv6: "",
      qos: { _5qi: 9, index: 9, arp: { preemptCap: "NOT_PREEMPT", preemptVuln: "NOT_PREEMPTABLE", priorityLevel: preset?.arpPriorityLevel ?? 9 } },
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
      hasUnsavedChanges,
      inputImsiExists, isCheckingInputImsi, inputMsisdnExists, isCheckingInputMsisdn,
      expandedSlices, isAccessRestrictionsExpanded, auth4GData, usimType, msisdn, ueAmbr, hasUeAmbr, slices,
      accessRestriction, profileList, profilesReady, selectedProfileName, profileBinding, ratingList, tariffPlanList, ocsPlanId, ocsPlanStatus, ocsContractStatus, hasOcsContract, hasOcsBalance, ocsRules, ocsPlmn,
      ocsTrafficTotalStr, ocsTrafficBalanceStr, ocsVoiceTotalStr, ocsVoiceBalanceStr,
      ocsSmsTotalStr, ocsSmsBalanceStr, ocsVolumeThreshold, ocsDataReservedStr
    },
    actions: {
      setIsEditing, setInputImsi: handleInputImsiChange, setMsisdn: handleMsisdnChange, loadFromProfile, setAuth4GData,
      setUsimType, setUeAmbr: (value: typeof ueAmbr) => { setHasUeAmbr(true); setUeAmbr(value); }, setIsAccessRestrictionsExpanded, setAccessRestriction, setOcsTrafficTotalStr,
      setOcsTrafficBalanceStr, setOcsVoiceTotalStr, setOcsVoiceBalanceStr, setOcsSmsTotalStr, setOcsSmsBalanceStr, setOcsPlanId, addSlice, handleSliceChange, removeSlice, setExpandedSlices, handleDelete,
      handleSave, scrollTo, discardDraft, clearError: () => setError(null), clearToastMessage: () => setToastMessage(null)
    }
  };
}
