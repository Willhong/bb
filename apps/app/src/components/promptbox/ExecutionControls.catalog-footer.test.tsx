// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { ModelReasoningMenu } from "@/components/pickers/ModelReasoningMenuSplit";
import { ExecutionControls } from "./ExecutionControls";

await ModelReasoningMenu.preload();
afterEach(cleanup);

it("keeps plugin controls inside the native model menu without changing selection", () => {
  const refresh = vi.fn();
  const change = vi.fn();
  const { wrapper } = createQueryClientTestHarness();
  render(
    <ExecutionControls
      provider={{
        selectedId: "codex",
        options: [{ value: "codex", label: "Codex" }],
        controlledCatalog: true,
      }}
      model={{
        selected: "gpt-6.2-sol",
        options: [{ value: "gpt-6.2-sol", label: "GPT-6.2 Sol" }],
        moreOptions: [],
        isLoading: false,
        loadFailed: false,
        onChange: change,
      }}
      reasoning={{
        value: "medium",
        options: [{ value: "medium", label: "Medium" }],
        isLoading: false,
        onChange: change,
      }}
      catalogFooter={
        <button onClick={refresh}>Refresh assistant models</button>
      }
    />,
    { wrapper },
  );
  expect(
    screen.queryByRole("button", { name: "Refresh assistant models" }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Provider, model and reasoning" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh assistant models" }),
  );
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(change).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Refresh assistant models" }),
  ).not.toBeNull();
});
