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
  InboundMessageDedupe,
  Invitation,
  KnowledgeGap,
  Message,
  MessageSenderType,
  OperatorAttention,
  ProviderBranch,
  ProviderProfile,
  ProviderService,
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
  InboundMessageDedupe,
  Invitation,
  KnowledgeGap,
  Message,
  MessageSenderType,
  OperatorAttention,
  ProviderBranch,
  ProviderProfile,
  ProviderService,
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
};
