import { useState } from "react";
import { App, Button, Form, Input, Modal } from "antd";
import { useTranslation } from "react-i18next";

import { getSupabaseClient } from "@/services/api/supabase";
import { useUserStore } from "@/stores/use-user-store";

export function AuthDialog() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const open = useUserStore((state) => state.authDialogOpen);
    const setOpen = useUserStore((state) => state.setAuthDialogOpen);
    const [submitting, setSubmitting] = useState(false);

    const submit = async (values: { email: string; password: string }) => {
        const client = getSupabaseClient();
        if (!client) return;
        setSubmitting(true);
        try {
            const { error } = await client.auth.signInWithPassword(values);
            if (error) throw error;
            setOpen(false);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("cloud.signInFailed"));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal title={t("cloud.signIn")} open={open} footer={null} destroyOnHidden onCancel={() => setOpen(false)} width={400}>
            <Form layout="vertical" onFinish={(values) => void submit(values)}>
                <Form.Item label={t("cloud.email")} name="email" rules={[{ required: true, type: "email" }]}>
                    <Input autoComplete="email" />
                </Form.Item>
                <Form.Item label={t("cloud.password")} name="password" rules={[{ required: true, min: 6 }]}>
                    <Input.Password autoComplete="current-password" />
                </Form.Item>
                <Button type="primary" htmlType="submit" loading={submitting} block>{t("cloud.signIn")}</Button>
            </Form>
        </Modal>
    );
}
