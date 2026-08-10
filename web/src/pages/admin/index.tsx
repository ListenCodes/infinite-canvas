import type { AdminAuditLog, AdminJob, AdminUser, ProviderChannel } from "@infinite-canvas/contracts";
import { App, Button, Checkbox, Empty, Form, Input, InputNumber, Modal, Popconfirm, Result, Select, Space, Spin, Table, Tabs, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { CircleDollarSign, KeyRound, Plus, RefreshCw, RotateCcw, ShieldOff, ShieldCheck, SlidersHorizontal, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
    adjustAdminWallet,
    createAdminModel,
    listAdminAudit,
    listAdminChannels,
    listAdminJobs,
    listAdminUsers,
    resolveAdminUnknown,
    rotateAdminCredential,
    saveAdminChannel,
    setAdminUserStatus,
    setAdminUserFeatures,
} from "@/services/api/cloud-admin";
import { useUserStore } from "@/stores/use-user-store";

type AdminModal =
    | { kind: "wallet"; user: AdminUser }
    | { kind: "features"; user: AdminUser }
    | { kind: "channel"; channel?: ProviderChannel }
    | { kind: "credential"; channel: ProviderChannel }
    | { kind: "model"; channel: ProviderChannel }
    | { kind: "resolve"; job: AdminJob }
    | null;

function nullableDate(value: string | null): string {
    return value ? dayjs(value).format("YYYY-MM-DD HH:mm:ss") : "-";
}

export default function AdminPage() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const authReady = useUserStore((state) => state.authReady);
    const authenticated = useUserStore((state) => state.authenticated);
    const platformRole = useUserStore((state) => state.platformRole);
    const openSignIn = useUserStore((state) => state.setAuthDialogOpen);
    const [users, setUsers] = useState<AdminUser[]>([]);
    const [channels, setChannels] = useState<ProviderChannel[]>([]);
    const [jobs, setJobs] = useState<AdminJob[]>([]);
    const [audit, setAudit] = useState<AdminAuditLog[]>([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [modal, setModal] = useState<AdminModal>(null);
    const [modalRequestKey, setModalRequestKey] = useState("");
    const [jobFilter, setJobFilter] = useState("all");
    const [form] = Form.useForm();
    const resolution = Form.useWatch("resolution", form);

    const refresh = useCallback(async () => {
        if (!authenticated || platformRole !== "admin") return;
        setLoading(true);
        try {
            const [nextUsers, nextChannels, nextJobs, nextAudit] = await Promise.all([listAdminUsers(), listAdminChannels(), listAdminJobs(), listAdminAudit()]);
            setUsers(nextUsers);
            setChannels(nextChannels);
            setJobs(nextJobs);
            setAudit(nextAudit);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.loadFailed"));
        } finally {
            setLoading(false);
        }
    }, [authenticated, message, platformRole, t]);

    useEffect(() => { void refresh(); }, [refresh]);

    const openModal = (next: Exclude<AdminModal, null>) => {
        setModal(next);
        setModalRequestKey(`${next.kind}:${crypto.randomUUID()}`);
        if (next.kind === "wallet") form.setFieldsValue({ workspaceId: next.user.workspaces[0]?.workspaceId, amount: "", reason: "" });
        if (next.kind === "features") form.setFieldsValue({ featureFlags: next.user.featureFlags, reason: "" });
        if (next.kind === "channel") form.setFieldsValue(next.channel ? { id: next.channel.id, name: next.channel.name, type: next.channel.type, baseUrl: next.channel.baseUrl, capabilities: next.channel.capabilities } : { name: "", type: "openai", baseUrl: "https://", capabilities: ["image"] });
        if (next.kind === "credential") form.setFieldsValue({ secret: "" });
        if (next.kind === "model") form.setFieldsValue({ model: "", capability: next.channel.capabilities[0], adapterType: next.channel.type, adapterVersion: 1, concurrencyLimit: 3, providerIdempotencySupported: false, creditAmount: "1", limits: "{}" });
        if (next.kind === "resolve") form.setFieldsValue({ resolution: "not_accepted", reason: "", evidence: "{}", providerTaskId: "", mediaUrl: "" });
    };

    const submitModal = async () => {
        if (!modal) return;
        const values = await form.validateFields();
        setSaving(true);
        try {
            if (modal.kind === "wallet") {
                await adjustAdminWallet({ workspaceId: values.workspaceId, amount: String(values.amount), reason: values.reason, confirmLargeDebit: Boolean(values.confirmLargeDebit) }, modalRequestKey);
            } else if (modal.kind === "features") {
                await setAdminUserFeatures(modal.user.userId, { featureFlags: values.featureFlags, reason: values.reason });
            } else if (modal.kind === "channel") {
                await saveAdminChannel({ id: modal.channel?.id, name: values.name, type: values.type, baseUrl: values.baseUrl, capabilities: values.capabilities }, modalRequestKey);
            } else if (modal.kind === "credential") {
                await rotateAdminCredential(modal.channel.id, { secret: values.secret }, modalRequestKey);
            } else if (modal.kind === "model") {
                let limits: unknown;
                try { limits = JSON.parse(values.limits || "{}"); } catch { throw new Error(t("admin.invalidJson")); }
                await createAdminModel(modal.channel.id, { ...values, adapterType: modal.channel.type, adapterVersion: Number(values.adapterVersion), concurrencyLimit: Number(values.concurrencyLimit), creditAmount: String(values.creditAmount), limits }, modalRequestKey);
            } else {
                let evidence: unknown;
                try { evidence = JSON.parse(values.evidence || "{}"); } catch { throw new Error(t("admin.invalidJson")); }
                const input = values.resolution === "accepted"
                    ? { resolution: values.resolution, providerTaskId: values.providerTaskId, reason: values.reason, evidence }
                    : values.resolution === "provider_succeeded"
                        ? { resolution: values.resolution, mediaUrl: values.mediaUrl, reason: values.reason, evidence }
                        : { resolution: values.resolution, reason: values.reason, evidence };
                await resolveAdminUnknown(modal.job.attemptId, input, modalRequestKey);
            }
            setModal(null);
            setModalRequestKey("");
            form.resetFields();
            await refresh();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.actionFailed"));
        } finally {
            setSaving(false);
        }
    };

    const changeUserStatus = async (user: AdminUser) => {
        try {
            await setAdminUserStatus(user.userId, { status: user.status === "active" ? "disabled" : "active", reason: user.status === "active" ? "Disabled by platform administrator" : "Restored by platform administrator" });
            await refresh();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.actionFailed"));
        }
    };

    const visibleJobs = useMemo(() => jobs.filter((job) => jobFilter === "all" || (jobFilter === "unknown" ? job.status === "outcome_unknown" : job.status !== "succeeded" && job.status !== "failed" && job.status !== "canceled")), [jobFilter, jobs]);

    if (!authReady) return <div className="flex h-full items-center justify-center"><Spin /></div>;
    if (!authenticated) return <Result status="403" title={t("admin.signInTitle")} extra={<Button type="primary" onClick={() => openSignIn(true)}>{t("cloud.signIn")}</Button>} />;
    if (platformRole !== "admin") return <Result status="403" title={t("admin.forbiddenTitle")} subTitle={t("admin.forbiddenDescription")} />;

    const usersTable = <Table<AdminUser> rowKey="userId" dataSource={users} scroll={{ x: 1000 }} pagination={{ pageSize: 20 }} locale={{ emptyText: <Empty /> }} columns={[
        { title: t("admin.user"), width: 220, render: (_, user) => <div><div className="font-medium">{user.displayName}</div><Typography.Text type="secondary" className="text-xs">{user.userId}</Typography.Text></div> },
        { title: t("admin.role"), dataIndex: "platformRole", width: 100, render: (value) => <Tag>{value}</Tag> },
        { title: t("admin.status"), dataIndex: "status", width: 110, render: (value) => <Tag color={value === "active" ? "success" : "error"}>{value}</Tag> },
        { title: t("admin.workspaces"), width: 240, render: (_, user) => user.workspaces.map((workspace) => `${workspace.name} (${workspace.role})`).join(", ") || "-" },
        { title: t("admin.balance"), width: 160, render: (_, user) => `${user.available} / ${user.reserved}` },
        { title: t("admin.lastLogin"), width: 180, render: (_, user) => nullableDate(user.lastLoginAt) },
        { title: t("admin.features"), width: 250, render: (_, user) => <Space size={[0, 4]} wrap>{Object.entries(user.featureFlags).filter(([, enabled]) => enabled).map(([name]) => <Tag key={name}>{t(`admin.featureNames.${name}`)}</Tag>)}</Space> },
        { title: t("tasks.actions"), fixed: "right", width: 190, render: (_, user) => <Space>
            <Button type="text" icon={<CircleDollarSign className="size-4" />} onClick={() => openModal({ kind: "wallet", user })} title={t("admin.adjustWallet")} aria-label={t("admin.adjustWallet")} disabled={!user.workspaces.length} />
            <Button type="text" icon={<SlidersHorizontal className="size-4" />} onClick={() => openModal({ kind: "features", user })} title={t("admin.features")} aria-label={t("admin.features")} />
            <Popconfirm title={user.status === "active" ? t("admin.disableConfirm") : t("admin.restoreConfirm")} onConfirm={() => void changeUserStatus(user)}><Button type="text" danger={user.status === "active"} icon={user.status === "active" ? <ShieldOff className="size-4" /> : <ShieldCheck className="size-4" />} title={user.status === "active" ? t("admin.disable") : t("admin.restore")} aria-label={user.status === "active" ? t("admin.disable") : t("admin.restore")} /></Popconfirm>
        </Space> },
    ]} />;

    const channelsTable = <><div className="mb-4 flex justify-end"><Button type="primary" icon={<Plus className="size-4" />} onClick={() => openModal({ kind: "channel" })}>{t("admin.addChannel")}</Button></div><Table<ProviderChannel> rowKey="id" dataSource={channels} scroll={{ x: 900 }} pagination={false} columns={[
        { title: t("admin.channel"), dataIndex: "name" },
        { title: t("tasks.type"), dataIndex: "type", width: 120 },
        { title: "Base URL", dataIndex: "baseUrl", ellipsis: true },
        { title: t("admin.capabilities"), dataIndex: "capabilities", width: 160, render: (values: string[]) => values.map((value) => <Tag key={value}>{value}</Tag>) },
        { title: t("admin.credential"), width: 130, render: (_, channel) => channel.credentialVersion ? `v${channel.credentialVersion} (...${channel.secretSuffix})` : "-" },
        { title: t("tasks.actions"), fixed: "right", width: 180, render: (_, channel) => <Space>
            <Button type="text" icon={<Wrench className="size-4" />} onClick={() => openModal({ kind: "channel", channel })} title={t("common.edit")} aria-label={t("common.edit")} />
            <Button type="text" icon={<KeyRound className="size-4" />} onClick={() => openModal({ kind: "credential", channel })} title={t("admin.rotateCredential")} aria-label={t("admin.rotateCredential")} />
            <Button type="text" icon={<Plus className="size-4" />} onClick={() => openModal({ kind: "model", channel })} title={t("admin.addModel")} aria-label={t("admin.addModel")} />
        </Space> },
    ]} /></>;

    const jobsTable = <><div className="mb-4"><Select value={jobFilter} onChange={setJobFilter} options={[{ value: "all", label: t("common.all") }, { value: "active", label: t("tasks.active") }, { value: "unknown", label: t("tasks.unknown") }]} /></div><Table<AdminJob> rowKey="jobId" dataSource={visibleJobs} scroll={{ x: 1100 }} pagination={{ pageSize: 20 }} columns={[
        { title: "Job", dataIndex: "jobId", ellipsis: true, width: 190 },
        { title: t("tasks.type"), dataIndex: "capability", width: 90 },
        { title: t("tasks.status"), dataIndex: "status", width: 160, render: (value) => <Tag color={value === "outcome_unknown" ? "warning" : "default"}>{value}</Tag> },
        { title: "Attempt", width: 120, render: (_, job) => `#${job.attemptNo}` },
        { title: t("tasks.error"), ellipsis: true, render: (_, job) => job.errorMessage || job.errorCode || "-" },
        { title: t("admin.deadline"), width: 180, render: (_, job) => nullableDate(job.releaseAfter) },
        { title: t("tasks.actions"), fixed: "right", width: 90, render: (_, job) => job.status === "outcome_unknown" ? <Button type="text" icon={<RotateCcw className="size-4" />} onClick={() => openModal({ kind: "resolve", job })} title={t("admin.resolve")} aria-label={t("admin.resolve")} /> : null },
    ]} /></>;

    const auditTable = <Table<AdminAuditLog> rowKey="id" dataSource={audit} scroll={{ x: 1000 }} pagination={{ pageSize: 30 }} columns={[
        { title: t("admin.time"), dataIndex: "createdAt", width: 180, render: nullableDate },
        { title: t("admin.action"), dataIndex: "action", width: 220 },
        { title: t("admin.actor"), dataIndex: "actorUserId", width: 220, ellipsis: true },
        { title: t("admin.target"), width: 240, render: (_, item) => `${item.targetType}: ${item.targetId}` },
        { title: t("admin.reason"), dataIndex: "reason", width: 240, ellipsis: true },
        { title: t("common.details"), render: (_, item) => <Typography.Text code>{JSON.stringify(item.afterSummary ?? item.beforeSummary ?? {})}</Typography.Text> },
    ]} />;

    return <main className="h-full overflow-y-auto bg-background text-stone-950 dark:text-stone-100"><div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <div className="flex items-end justify-between border-b border-stone-200 pb-5 dark:border-stone-800"><div><h1 className="text-xl font-semibold">{t("admin.title")}</h1><p className="mt-1 text-sm text-stone-500">{t("admin.description")}</p></div><Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void refresh()}>{t("tasks.refresh")}</Button></div>
        <Tabs className="mt-3" items={[{ key: "users", label: t("admin.users"), children: usersTable }, { key: "channels", label: t("admin.channels"), children: channelsTable }, { key: "jobs", label: t("admin.jobs"), children: jobsTable }, { key: "audit", label: t("admin.audit"), children: auditTable }]} />
    </div>
    <Modal open={Boolean(modal)} title={modal ? t(`admin.modals.${modal.kind}`) : ""} confirmLoading={saving} onCancel={() => { setModal(null); setModalRequestKey(""); form.resetFields(); }} onOk={() => void submitModal()} destroyOnHidden>
        <Form form={form} layout="vertical" className="pt-3">
            {modal?.kind === "wallet" ? <><Form.Item name="workspaceId" label={t("admin.workspace")} rules={[{ required: true }]}><Select options={modal.user.workspaces.map((workspace) => ({ value: workspace.workspaceId, label: workspace.name }))} /></Form.Item><Form.Item name="amount" label={t("admin.amount")} rules={[{ required: true, pattern: /^-?[1-9]\d*$/ }]}><Input /></Form.Item><Form.Item name="confirmLargeDebit" valuePropName="checked"><Checkbox>{t("admin.confirmLargeDebit")}</Checkbox></Form.Item></> : null}
            {modal?.kind === "features" ? <div className="grid grid-cols-1 gap-1 sm:grid-cols-2"><Form.Item name={["featureFlags", "projects"]} valuePropName="checked"><Checkbox>{t("admin.featureNames.projects")}</Checkbox></Form.Item><Form.Item name={["featureFlags", "imageGeneration"]} valuePropName="checked"><Checkbox>{t("admin.featureNames.imageGeneration")}</Checkbox></Form.Item><Form.Item name={["featureFlags", "videoGeneration"]} valuePropName="checked"><Checkbox>{t("admin.featureNames.videoGeneration")}</Checkbox></Form.Item><Form.Item name={["featureFlags", "credits"]} valuePropName="checked"><Checkbox>{t("admin.featureNames.credits")}</Checkbox></Form.Item></div> : null}
            {modal?.kind === "channel" ? <><Form.Item name="name" label={t("admin.channelName")} rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="type" label={t("tasks.type")} rules={[{ required: true }]}><Select options={["grok2api", "sub2api", "openai"].map((value) => ({ value, label: value }))} /></Form.Item><Form.Item name="baseUrl" label="Base URL" rules={[{ required: true, type: "url" }]}><Input /></Form.Item><Form.Item name="capabilities" label={t("admin.capabilities")} rules={[{ required: true }]}><Checkbox.Group options={["image", "video"]} /></Form.Item></> : null}
            {modal?.kind === "credential" ? <Form.Item name="secret" label={t("admin.secret")} rules={[{ required: true, min: 8 }]}><Input.Password autoComplete="new-password" /></Form.Item> : null}
            {modal?.kind === "model" ? <><Form.Item name="model" label={t("admin.model")} rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="capability" label={t("admin.capabilities")} rules={[{ required: true }]}><Select options={modal.channel.capabilities.map((value) => ({ value, label: value }))} /></Form.Item><Form.Item name="creditAmount" label={t("admin.price")} rules={[{ required: true, pattern: /^\d+$/ }]}><Input /></Form.Item><Form.Item name="concurrencyLimit" label={t("admin.concurrency")}><InputNumber min={1} max={100} className="w-full" /></Form.Item><Form.Item name="providerIdempotencySupported" valuePropName="checked"><Checkbox>{t("admin.providerIdempotency")}</Checkbox></Form.Item><Form.Item name="limits" label={t("admin.limitsJson")}><Input.TextArea rows={4} /></Form.Item></> : null}
            {modal?.kind === "resolve" ? <><Form.Item name="resolution" label={t("admin.resolution")} rules={[{ required: true }]}><Select options={["not_accepted", "provider_failed", "accepted", "provider_succeeded"].map((value) => ({ value, label: value }))} /></Form.Item>{resolution === "accepted" ? <Form.Item name="providerTaskId" label="Provider Task ID" rules={[{ required: true }]}><Input /></Form.Item> : null}{resolution === "provider_succeeded" ? <Form.Item name="mediaUrl" label="Media URL" rules={[{ required: true, type: "url" }]}><Input /></Form.Item> : null}<Form.Item name="evidence" label={t("admin.evidenceJson")}><Input.TextArea rows={4} /></Form.Item></> : null}
            {modal && modal.kind !== "channel" && modal.kind !== "credential" && modal.kind !== "model" ? <Form.Item name="reason" label={t("admin.reason")} rules={[{ required: true, min: 3 }]}><Input.TextArea rows={3} /></Form.Item> : null}
        </Form>
    </Modal></main>;
}
