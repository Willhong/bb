import type { ProviderInfo } from "@bb/domain";
import type { PickerOption } from "@bb/shared-ui/option-picker";
import { getProviderIconInfo } from "@/lib/provider-icon";

export interface ProviderPickerOption extends PickerOption<string> {
  brandPrefix?: string;
  planModeCopy?: string;
  installUrl?: string;
}

export function toProviderPickerOption(
  provider: ProviderInfo,
): ProviderPickerOption {
  return {
    value: provider.id,
    label: provider.displayName,
    icon: getProviderIconInfo("agent", provider.id, provider)?.icon,
    ...(provider.strings?.brandPrefix === undefined
      ? {}
      : { brandPrefix: provider.strings.brandPrefix }),
    ...(provider.strings?.planModeCopy === undefined
      ? {}
      : { planModeCopy: provider.strings.planModeCopy }),
    ...(provider.strings?.installUrl === undefined
      ? {}
      : { installUrl: provider.strings.installUrl }),
  };
}

export function stripModelBrandPrefix(
  label: string,
  brandPrefix: string | undefined,
): string {
  if (brandPrefix === undefined || brandPrefix.length === 0) {
    return label;
  }
  return label.toLowerCase().startsWith(brandPrefix.toLowerCase())
    ? label.slice(brandPrefix.length).trimStart()
    : label;
}
