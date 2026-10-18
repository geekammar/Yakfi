/**
 * Typed server models — single import surface over the generated
 * Prisma client. Application code should never deep-import from
 * `@/generated/prisma`; use these aliases instead.
 */

import type {
  Appointment,
  AppointmentStatus,
  Branch,
  Business,
  Conversation,
  ConversationStatus,
  Customer,
  FollowUpRequest,
  FollowUpRequestStatus,
  InboundMessageDedupe,
  Invitation,
  KnowledgeGap,
  Message,
  MessageSenderType,
  OperatorAttention,
  ProviderBranch,
  ProviderProfile,
  ProviderService,
  ProviderServiceExclusion,
  RuntimeCredential,
  Service,
  TelegramConnection,
  TelegramProvisioningLedger,
  UsageRecord,
  UserRole,
  WhatsAppConnection,
  WhatsAppOnboardingAuthorization,
} from "@/generated/prisma/client";

export type {
  Appointment,
  AppointmentStatus,
  Branch,
  Business,
  Conversation,
  ConversationStatus,
  Customer,
  FollowUpRequest,
  FollowUpRequestStatus,
  InboundMessageDedupe,
  Invitation,
  KnowledgeGap,
  Message,
  MessageSenderType,
  OperatorAttention,
  ProviderBranch,
  ProviderProfile,
  ProviderService,
  ProviderServiceExclusion,
  RuntimeCredential,
  Service,
  TelegramConnection,
  TelegramProvisioningLedger,
  UsageRecord,
  UserRole,
  WhatsAppConnection,
  WhatsAppOnboardingAuthorization,
};

/** Conversation with its messages (thread view). */
export type ConversationWithMessages = Conversation & {
  messages: Message[];
};

/** Conversation with the customer preloaded (list views). */
export type ConversationWithCustomer = Conversation & {
  customer: Pick<Customer, "id" | "name" | "phone">;
};

/** Appointment with customer + service (agenda views). */
export type AppointmentWithRelations = Appointment & {
  customer: Pick<Customer, "id" | "name" | "phone">;
  service: Pick<Service, "id" | "name" | "durationMinutes">;
  provider?: Pick<ProviderProfile, "id" | "name" | "displayName"> | null;
};

/** FollowUpRequest with customer + service + provider + appointments (detail & list views). */
export type FollowUpRequestWithRelations = FollowUpRequest & {
  customer: Pick<Customer, "id" | "name" | "phone">;
  service?: Pick<Service, "id" | "name" | "durationMinutes"> | null;
  preferredProvider?: Pick<
    ProviderProfile,
    "id" | "name" | "displayName"
  > | null;
  sourceAppointment?: Pick<
    Appointment,
    "id" | "date" | "startTime" | "endTime"
  > | null;
  scheduledAppointment?: Pick<
    Appointment,
    "id" | "date" | "startTime" | "endTime" | "status"
  > | null;
};
