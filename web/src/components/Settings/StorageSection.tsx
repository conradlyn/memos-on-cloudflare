import { create } from "@bufbuild/protobuf";
import { isEqual } from "lodash-es";
import { HardDriveUploadIcon, ServerIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useInstance } from "@/contexts/InstanceContext";
import {
  InstanceSetting_Key,
  InstanceSetting_StorageSetting,
  InstanceSetting_StorageSettingSchema,
  InstanceSettingSchema,
} from "@/types/proto/api/v1/instance_service_pb";
import { useTranslate } from "@/utils/i18n";
import SettingGroup from "./SettingGroup";
import { SettingPanel } from "./SettingList";
import SettingRow from "./SettingRow";
import SettingSection from "./SettingSection";
import useInstanceSettingUpdater, { buildInstanceSettingName } from "./useInstanceSettingUpdater";

const FALLBACK_UPLOAD_LIMIT_MB = 100;

const StorageSection = () => {
  const t = useTranslate();
  const saveInstanceSetting = useInstanceSettingUpdater();
  const { storageSetting: originalSetting } = useInstance();
  const [localSetting, setLocalSetting] = useState<InstanceSetting_StorageSetting>(originalSetting);

  useEffect(() => {
    setLocalSetting(originalSetting);
  }, [originalSetting]);

  const uploadSizeLimitMb = useMemo(() => {
    const value = Number(localSetting.uploadSizeLimitMb || 0);
    return value > 0 ? value : FALLBACK_UPLOAD_LIMIT_MB;
  }, [localSetting.uploadSizeLimitMb]);

  const handleUploadLimitChange = (value: string) => {
    const parsed = Number.parseInt(value, 10);
    setLocalSetting(
      create(InstanceSetting_StorageSettingSchema, {
        ...localSetting,
        uploadSizeLimitMb: BigInt(Number.isNaN(parsed) ? 0 : parsed),
      }),
    );
  };

  const canSave = useMemo(() => {
    return uploadSizeLimitMb > 0 && !isEqual(originalSetting, localSetting);
  }, [localSetting, originalSetting, uploadSizeLimitMb]);

  const handleSave = async () => {
    await saveInstanceSetting({
      key: InstanceSetting_Key.STORAGE,
      setting: create(InstanceSettingSchema, {
        name: buildInstanceSettingName(InstanceSetting_Key.STORAGE),
        value: {
          case: "storageSetting",
          value: localSetting,
        },
      }),
      errorContext: "Update storage settings",
    });
  };

  return (
    <SettingSection title={t("setting.storage.label")}>
      <SettingGroup title={t("setting.storage.current-storage")} description={t("setting.storage.current-storage-description")}>
        <SettingPanel className="rounded-md border border-border bg-muted/20 px-3 py-3">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <ServerIcon className="size-4" />
              <span>{t("setting.storage.current-backend-r2")}</span>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              {t("setting.storage.current-backend-description")}
            </p>
          </div>
        </SettingPanel>
      </SettingGroup>

      <SettingGroup
        title={t("setting.system.max-upload-size")}
        description={t("setting.system.max-upload-size-hint")}
        showSeparator
      >
        <SettingRow label={t("setting.system.max-upload-size")} tooltip={t("setting.system.max-upload-size-hint")}>
          <div className="flex items-center gap-2">
            <Input className="w-24 font-mono" value={String(uploadSizeLimitMb)} onChange={(e) => handleUploadLimitChange(e.target.value)} />
            <span className="text-xs text-muted-foreground">MiB</span>
          </div>
        </SettingRow>

        <SettingPanel className="rounded-md border border-border bg-muted/20 px-3 py-3">
          <div className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
            <HardDriveUploadIcon className="mt-0.5 size-4 shrink-0" />
            <span>{t("setting.storage.upload-limit-description")}</span>
          </div>
        </SettingPanel>
      </SettingGroup>

      <div className="w-full flex justify-end">
        <Button disabled={!canSave} onClick={handleSave}>
          {t("common.save")}
        </Button>
      </div>
    </SettingSection>
  );
};

export default StorageSection;
