/**
 * Repository layer — the only place that talks to Prisma directly.
 *
 * Rules:
 * - Repositories accept validated DTOs (from `@/lib/validation`) and
 *   return typed models (`@/types/domain`).
 * - Soft deletes: reads always filter `deletedAt: null`; writes flag
 *   `deletedAt` instead of removing rows.
 * - Features depend on these repositories, never on `db` directly.
 */

import { AiPolicyRepository } from "./ai-policy.repository";
import { AppointmentRepository } from "./appointment.repository";
import { BranchRepository } from "./branch.repository";
import { BusinessRepository } from "./business.repository";
import { ConversationRepository } from "./conversation.repository";
import { CustomerRepository } from "./customer.repository";
import { InboundDedupeRepository } from "./inbound-dedupe.repository";
import { InvitationRepository } from "./invitation.repository";
import { OperatorAttentionRepository } from "./operator-attention.repository";
import { PlatformInvitationRepository } from "./platform-invitation.repository";
import { ProviderRepository } from "./provider.repository";
import { RuntimeCredentialRepository } from "./runtime-credential.repository";
import { ServiceRepository } from "./service.repository";
import { UsageRepository } from "./usage.repository";
import { UserRepository } from "./user.repository";
import { WhatsAppConnectionRepository } from "./whatsapp-connection.repository";
import { WhatsAppOnboardingAuthorizationRepository } from "./whatsapp-onboarding-authorization.repository";

export const businessRepository = new BusinessRepository();
export const userRepository = new UserRepository();
export const serviceRepository = new ServiceRepository();
export const customerRepository = new CustomerRepository();
export const conversationRepository = new ConversationRepository();
export const appointmentRepository = new AppointmentRepository();
export const invitationRepository = new InvitationRepository();
export const branchRepository = new BranchRepository();
export const whatsAppConnectionRepository = new WhatsAppConnectionRepository();
export const whatsAppOnboardingAuthorizationRepository =
  new WhatsAppOnboardingAuthorizationRepository();
export const providerRepository = new ProviderRepository();
export const inboundDedupeRepository = new InboundDedupeRepository();
export const usageRepository = new UsageRepository();
export const operatorAttentionRepository = new OperatorAttentionRepository();
export const platformInvitationRepository = new PlatformInvitationRepository();
export const aiPolicyRepository = new AiPolicyRepository();
export const runtimeCredentialRepository = new RuntimeCredentialRepository();

export {
  AppointmentRepository,
  AiPolicyRepository,
  BranchRepository,
  BusinessRepository,
  ConversationRepository,
  CustomerRepository,
  InboundDedupeRepository,
  InvitationRepository,
  OperatorAttentionRepository,
  PlatformInvitationRepository,
  ProviderRepository,
  RuntimeCredentialRepository,
  ServiceRepository,
  UsageRepository,
  UserRepository,
  WhatsAppConnectionRepository,
  WhatsAppOnboardingAuthorizationRepository,
};
