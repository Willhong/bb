import { useId } from "react";
import type { MarkdownProps } from "@get-bb/plugin-sdk";
import { ConversationMessageContent } from "@/components/thread/timeline/ConversationMessageContent";
import { WithoutThreadTimelineNavigation } from "@/components/thread/timeline/ThreadTimelineNavigationContext";

export function PluginConversationMessage({
  role,
  text,
  timestamp,
}: NonNullable<MarkdownProps["experimental_chatMessage"]> & { text: string }) {
  const id = useId();
  return (
    <WithoutThreadTimelineNavigation>
      {role === "user" ? (
        <ConversationMessageContent
          role="user"
          text={text}
          timestamp={timestamp}
          attachments={null}
          initiator="user"
          mentions={[]}
          senderThreadId={null}
          senderThreadTitle={null}
          senderIsPluginSideChat={false}
          systemMessageKind="unlabeled"
          systemMessageSubject={null}
          turnRequest={{
            kind: "message",
            status: "accepted",
            isGrouped: false,
          }}
        />
      ) : (
        <ConversationMessageContent
          role="assistant"
          id={id}
          turnId={null}
          text={text}
          timestamp={timestamp}
          attachments={null}
          streaming={false}
          showActions
          mobileActionDisplay="overflow"
        />
      )}
    </WithoutThreadTimelineNavigation>
  );
}
