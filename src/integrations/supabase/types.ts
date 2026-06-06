export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      admin_audit_log: {
        Row: {
          acted_at: string
          action: string
          actor_user_id: string | null
          id: string
          payload: Json | null
          target_tenant_id: string | null
          target_user_id: string | null
        }
        Insert: {
          acted_at?: string
          action: string
          actor_user_id?: string | null
          id?: string
          payload?: Json | null
          target_tenant_id?: string | null
          target_user_id?: string | null
        }
        Update: {
          acted_at?: string
          action?: string
          actor_user_id?: string | null
          id?: string
          payload?: Json | null
          target_tenant_id?: string | null
          target_user_id?: string | null
        }
        Relationships: []
      }
      agent_defaults: {
        Row: {
          agent_kind: string
          created_at: string
          defaults: Json
          id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          agent_kind: string
          created_at?: string
          defaults?: Json
          id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          agent_kind?: string
          created_at?: string
          defaults?: Json
          id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      canonical_brands: {
        Row: {
          aliases: string[]
          category: string
          created_at: string
          display_name: string
          id: string
          manufacturer: string | null
          notes: string | null
          unit_type: string
          updated_at: string
        }
        Insert: {
          aliases?: string[]
          category: string
          created_at?: string
          display_name: string
          id?: string
          manufacturer?: string | null
          notes?: string | null
          unit_type: string
          updated_at?: string
        }
        Update: {
          aliases?: string[]
          category?: string
          created_at?: string
          display_name?: string
          id?: string
          manufacturer?: string | null
          notes?: string | null
          unit_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      csv_scanner_leads: {
        Row: {
          appointment_count: number | null
          created_at: string
          date_range_end: string | null
          date_range_start: string | null
          detected_platform: string | null
          email: string
          estimated_monthly_leak_usd: number | null
          estimated_monthly_recovery_usd: number | null
          followup_error: string | null
          followup_message_id: string | null
          followup_report_html: string | null
          followup_report_token: string | null
          followup_sent_at: string | null
          header_sample: string[] | null
          id: string
          ip_hash: string | null
          noshow_count: number | null
          setup_intent_at: string | null
          setup_intent_estimated_monthly_cancels: number | null
          setup_intent_notes: string | null
          setup_intent_notified_at: string | null
          setup_intent_notified_error: string | null
          setup_intent_phone: string | null
          setup_intent_practice_name: string | null
          setup_intent_scheduler: string | null
          source: string | null
          token_consumed_at: string | null
          user_agent: string | null
          user_id: string | null
          was_ai_mapped: boolean
        }
        Insert: {
          appointment_count?: number | null
          created_at?: string
          date_range_end?: string | null
          date_range_start?: string | null
          detected_platform?: string | null
          email: string
          estimated_monthly_leak_usd?: number | null
          estimated_monthly_recovery_usd?: number | null
          followup_error?: string | null
          followup_message_id?: string | null
          followup_report_html?: string | null
          followup_report_token?: string | null
          followup_sent_at?: string | null
          header_sample?: string[] | null
          id?: string
          ip_hash?: string | null
          noshow_count?: number | null
          setup_intent_at?: string | null
          setup_intent_estimated_monthly_cancels?: number | null
          setup_intent_notes?: string | null
          setup_intent_notified_at?: string | null
          setup_intent_notified_error?: string | null
          setup_intent_phone?: string | null
          setup_intent_practice_name?: string | null
          setup_intent_scheduler?: string | null
          source?: string | null
          token_consumed_at?: string | null
          user_agent?: string | null
          user_id?: string | null
          was_ai_mapped?: boolean
        }
        Update: {
          appointment_count?: number | null
          created_at?: string
          date_range_end?: string | null
          date_range_start?: string | null
          detected_platform?: string | null
          email?: string
          estimated_monthly_leak_usd?: number | null
          estimated_monthly_recovery_usd?: number | null
          followup_error?: string | null
          followup_message_id?: string | null
          followup_report_html?: string | null
          followup_report_token?: string | null
          followup_sent_at?: string | null
          header_sample?: string[] | null
          id?: string
          ip_hash?: string | null
          noshow_count?: number | null
          setup_intent_at?: string | null
          setup_intent_estimated_monthly_cancels?: number | null
          setup_intent_notes?: string | null
          setup_intent_notified_at?: string | null
          setup_intent_notified_error?: string | null
          setup_intent_phone?: string | null
          setup_intent_practice_name?: string | null
          setup_intent_scheduler?: string | null
          source?: string | null
          token_consumed_at?: string | null
          user_agent?: string | null
          user_id?: string | null
          was_ai_mapped?: boolean
        }
        Relationships: []
      }
      email_send_log: {
        Row: {
          created_at: string
          error_message: string | null
          id: string
          message_id: string | null
          metadata: Json | null
          recipient_email: string
          status: string
          template_name: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          id?: string
          message_id?: string | null
          metadata?: Json | null
          recipient_email: string
          status: string
          template_name: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          id?: string
          message_id?: string | null
          metadata?: Json | null
          recipient_email?: string
          status?: string
          template_name?: string
        }
        Relationships: []
      }
      email_send_state: {
        Row: {
          auth_email_ttl_minutes: number
          batch_size: number
          id: number
          retry_after_until: string | null
          send_delay_ms: number
          transactional_email_ttl_minutes: number
          updated_at: string
        }
        Insert: {
          auth_email_ttl_minutes?: number
          batch_size?: number
          id?: number
          retry_after_until?: string | null
          send_delay_ms?: number
          transactional_email_ttl_minutes?: number
          updated_at?: string
        }
        Update: {
          auth_email_ttl_minutes?: number
          batch_size?: number
          id?: number
          retry_after_until?: string | null
          send_delay_ms?: number
          transactional_email_ttl_minutes?: number
          updated_at?: string
        }
        Relationships: []
      }
      email_unsubscribe_tokens: {
        Row: {
          created_at: string
          email: string
          id: string
          token: string
          used_at: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          token: string
          used_at?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          token?: string
          used_at?: string | null
        }
        Relationships: []
      }
      emma_appointment_status_events: {
        Row: {
          appointment_id: string
          created_at: string
          from_status: string
          id: string
          reason: string | null
          to_status: string
          triggered_by: string
          user_id: string
        }
        Insert: {
          appointment_id: string
          created_at?: string
          from_status: string
          id?: string
          reason?: string | null
          to_status: string
          triggered_by: string
          user_id: string
        }
        Update: {
          appointment_id?: string
          created_at?: string
          from_status?: string
          id?: string
          reason?: string | null
          to_status?: string
          triggered_by?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "emma_appointment_status_events_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "emma_appointments"
            referencedColumns: ["id"]
          },
        ]
      }
      emma_appointments: {
        Row: {
          booking_email: string | null
          booking_name: string | null
          booking_phone: string | null
          booking_token: string | null
          created_at: string
          during: string | null
          duration_min: number
          external_id: string | null
          id: string
          notes: string | null
          patient_node_id: string | null
          provider_id: string | null
          provider_name: string | null
          recovery_event_id: string | null
          resource_id: string | null
          scheduled_at: string
          slot_held_until: string | null
          source: string
          status: string
          treatment_type: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          booking_email?: string | null
          booking_name?: string | null
          booking_phone?: string | null
          booking_token?: string | null
          created_at?: string
          during?: never
          duration_min?: number
          external_id?: string | null
          id?: string
          notes?: string | null
          patient_node_id?: string | null
          provider_id?: string | null
          provider_name?: string | null
          recovery_event_id?: string | null
          resource_id?: string | null
          scheduled_at: string
          slot_held_until?: string | null
          source?: string
          status?: string
          treatment_type?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          booking_email?: string | null
          booking_name?: string | null
          booking_phone?: string | null
          booking_token?: string | null
          created_at?: string
          during?: never
          duration_min?: number
          external_id?: string | null
          id?: string
          notes?: string | null
          patient_node_id?: string | null
          provider_id?: string | null
          provider_name?: string | null
          recovery_event_id?: string | null
          resource_id?: string | null
          scheduled_at?: string
          slot_held_until?: string | null
          source?: string
          status?: string
          treatment_type?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "emma_appointments_patient_node_id_fkey"
            columns: ["patient_node_id"]
            isOneToOne: false
            referencedRelation: "knowledge_nodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emma_appointments_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "scheduling_providers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emma_appointments_recovery_event_id_fkey"
            columns: ["recovery_event_id"]
            isOneToOne: false
            referencedRelation: "emma_recovery_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emma_appointments_resource_id_fkey"
            columns: ["resource_id"]
            isOneToOne: false
            referencedRelation: "scheduling_resources"
            referencedColumns: ["id"]
          },
        ]
      }
      emma_csv_dialect_cache: {
        Row: {
          alias_map: Json
          created_at: string
          detected_platform: string | null
          header_hash: string
          id: string
          llm_at: string
          llm_model: string
          updated_at: string
          use_count: number
          user_corrected_at: string | null
          user_id: string
        }
        Insert: {
          alias_map: Json
          created_at?: string
          detected_platform?: string | null
          header_hash: string
          id?: string
          llm_at?: string
          llm_model: string
          updated_at?: string
          use_count?: number
          user_corrected_at?: string | null
          user_id: string
        }
        Update: {
          alias_map?: Json
          created_at?: string
          detected_platform?: string | null
          header_hash?: string
          id?: string
          llm_at?: string
          llm_model?: string
          updated_at?: string
          use_count?: number
          user_corrected_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      emma_deposit_holds: {
        Row: {
          amount_usd: number
          applied_at: string | null
          appointment_id: string
          created_at: string
          held_at: string | null
          id: string
          intent_logged_at: string
          notes: string | null
          patient_node_id: string
          refunded_at: string | null
          status: string
          stripe_payment_intent_id: string | null
          trigger_reason: string
          updated_at: string
          user_id: string
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          amount_usd: number
          applied_at?: string | null
          appointment_id: string
          created_at?: string
          held_at?: string | null
          id?: string
          intent_logged_at?: string
          notes?: string | null
          patient_node_id: string
          refunded_at?: string | null
          status?: string
          stripe_payment_intent_id?: string | null
          trigger_reason: string
          updated_at?: string
          user_id: string
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          amount_usd?: number
          applied_at?: string | null
          appointment_id?: string
          created_at?: string
          held_at?: string | null
          id?: string
          intent_logged_at?: string
          notes?: string | null
          patient_node_id?: string
          refunded_at?: string | null
          status?: string
          stripe_payment_intent_id?: string | null
          trigger_reason?: string
          updated_at?: string
          user_id?: string
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "emma_deposit_holds_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: true
            referencedRelation: "emma_appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emma_deposit_holds_patient_node_id_fkey"
            columns: ["patient_node_id"]
            isOneToOne: false
            referencedRelation: "knowledge_nodes"
            referencedColumns: ["id"]
          },
        ]
      }
      emma_email_quarantine: {
        Row: {
          created_at: string
          from_address: string | null
          id: string
          inbound_slug: string | null
          light_mode_connection_id: string | null
          message_id: string | null
          parser_confidence: number | null
          platform: string | null
          raw_html: string | null
          raw_text: string | null
          reason: string | null
          received_at: string
          reviewed_at: string | null
          reviewed_by: string | null
          reviewed_notes: string | null
          reviewed_outcome: string | null
          subject: string | null
          to_address: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          from_address?: string | null
          id?: string
          inbound_slug?: string | null
          light_mode_connection_id?: string | null
          message_id?: string | null
          parser_confidence?: number | null
          platform?: string | null
          raw_html?: string | null
          raw_text?: string | null
          reason?: string | null
          received_at?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          reviewed_notes?: string | null
          reviewed_outcome?: string | null
          subject?: string | null
          to_address?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          from_address?: string | null
          id?: string
          inbound_slug?: string | null
          light_mode_connection_id?: string | null
          message_id?: string | null
          parser_confidence?: number | null
          platform?: string | null
          raw_html?: string | null
          raw_text?: string | null
          reason?: string | null
          received_at?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          reviewed_notes?: string | null
          reviewed_outcome?: string | null
          subject?: string | null
          to_address?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "emma_email_quarantine_light_mode_connection_id_fkey"
            columns: ["light_mode_connection_id"]
            isOneToOne: false
            referencedRelation: "emma_light_mode_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      emma_invoices: {
        Row: {
          created_at: string
          generated_at: string
          id: string
          monthly_flat_usd: number
          notes: string | null
          paid_at: string | null
          period_end: string
          period_start: string
          plan_at_invoice: string
          recovered_revenue_count: number
          recovered_revenue_usd: number
          revenue_share_pct: number
          sent_at: string | null
          share_due_usd: number
          status: string
          stripe_invoice_id: string | null
          total_due_usd: number
          updated_at: string
          user_id: string
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          created_at?: string
          generated_at?: string
          id?: string
          monthly_flat_usd: number
          notes?: string | null
          paid_at?: string | null
          period_end: string
          period_start: string
          plan_at_invoice: string
          recovered_revenue_count?: number
          recovered_revenue_usd?: number
          revenue_share_pct: number
          sent_at?: string | null
          share_due_usd?: number
          status?: string
          stripe_invoice_id?: string | null
          total_due_usd?: number
          updated_at?: string
          user_id: string
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          created_at?: string
          generated_at?: string
          id?: string
          monthly_flat_usd?: number
          notes?: string | null
          paid_at?: string | null
          period_end?: string
          period_start?: string
          plan_at_invoice?: string
          recovered_revenue_count?: number
          recovered_revenue_usd?: number
          revenue_share_pct?: number
          sent_at?: string | null
          share_due_usd?: number
          status?: string
          stripe_invoice_id?: string | null
          total_due_usd?: number
          updated_at?: string
          user_id?: string
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: []
      }
      emma_light_mode_connections: {
        Row: {
          created_at: string
          events_parsed_total: number
          events_quarantined_total: number
          id: string
          inbound_slug: string
          last_error: string | null
          last_event_at: string | null
          notes: string | null
          platform: string
          status: string
          tenant_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          events_parsed_total?: number
          events_quarantined_total?: number
          id?: string
          inbound_slug?: string
          last_error?: string | null
          last_event_at?: string | null
          notes?: string | null
          platform: string
          status?: string
          tenant_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          events_parsed_total?: number
          events_quarantined_total?: number
          id?: string
          inbound_slug?: string
          last_error?: string | null
          last_event_at?: string | null
          notes?: string | null
          platform?: string
          status?: string
          tenant_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "emma_light_mode_connections_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      emma_noshow_policies: {
        Row: {
          created_at: string
          deposit_amount_usd: number | null
          deposit_enabled: boolean
          deposit_refund_window_hours: number
          deposit_trigger: string | null
          grace_credits_per_6mo: number
          id: string
          optin_footer_enabled: boolean
          optin_footer_text: string
          optin_list_url: string | null
          preshow_cadence_hours: number[]
          preshow_channel: string
          preshow_enabled: boolean
          preshow_tone: string
          reliability_tier_thresholds: Json
          rescue_eligible_treatments: string[]
          rescue_enabled: boolean
          rescue_max_concurrent: number
          rescue_outreach_window_min: number
          rescue_proxy_email: string | null
          rescue_proxy_phone: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          deposit_amount_usd?: number | null
          deposit_enabled?: boolean
          deposit_refund_window_hours?: number
          deposit_trigger?: string | null
          grace_credits_per_6mo?: number
          id?: string
          optin_footer_enabled?: boolean
          optin_footer_text?: string
          optin_list_url?: string | null
          preshow_cadence_hours?: number[]
          preshow_channel?: string
          preshow_enabled?: boolean
          preshow_tone?: string
          reliability_tier_thresholds?: Json
          rescue_eligible_treatments?: string[]
          rescue_enabled?: boolean
          rescue_max_concurrent?: number
          rescue_outreach_window_min?: number
          rescue_proxy_email?: string | null
          rescue_proxy_phone?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          deposit_amount_usd?: number | null
          deposit_enabled?: boolean
          deposit_refund_window_hours?: number
          deposit_trigger?: string | null
          grace_credits_per_6mo?: number
          id?: string
          optin_footer_enabled?: boolean
          optin_footer_text?: string
          optin_list_url?: string | null
          preshow_cadence_hours?: number[]
          preshow_channel?: string
          preshow_enabled?: boolean
          preshow_tone?: string
          reliability_tier_thresholds?: Json
          rescue_eligible_treatments?: string[]
          rescue_enabled?: boolean
          rescue_max_concurrent?: number
          rescue_outreach_window_min?: number
          rescue_proxy_email?: string | null
          rescue_proxy_phone?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      emma_pattern_alerts: {
        Row: {
          body: string | null
          created_at: string
          dismissed_at: string | null
          dismissed_by: string | null
          from_tier: string | null
          headline: string
          id: string
          kind: string
          patient_node_id: string
          to_tier: string
          user_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          dismissed_at?: string | null
          dismissed_by?: string | null
          from_tier?: string | null
          headline: string
          id?: string
          kind: string
          patient_node_id: string
          to_tier: string
          user_id: string
        }
        Update: {
          body?: string | null
          created_at?: string
          dismissed_at?: string | null
          dismissed_by?: string | null
          from_tier?: string | null
          headline?: string
          id?: string
          kind?: string
          patient_node_id?: string
          to_tier?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "emma_pattern_alerts_patient_node_id_fkey"
            columns: ["patient_node_id"]
            isOneToOne: false
            referencedRelation: "knowledge_nodes"
            referencedColumns: ["id"]
          },
        ]
      }
      emma_preshow_message_templates: {
        Row: {
          body_template: string
          created_at: string
          id: string
          offset_hours: number
          profile_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          body_template: string
          created_at?: string
          id?: string
          offset_hours: number
          profile_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          body_template?: string
          created_at?: string
          id?: string
          offset_hours?: number
          profile_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "emma_preshow_message_templates_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "emma_preshow_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      emma_preshow_profiles: {
        Row: {
          cadence_by_treatment_type: Json
          cadence_hours: number[]
          channel: string
          created_at: string
          id: string
          is_default: boolean
          name: string
          tone: string
          updated_at: string
          user_id: string
        }
        Insert: {
          cadence_by_treatment_type?: Json
          cadence_hours?: number[]
          channel?: string
          created_at?: string
          id?: string
          is_default?: boolean
          name: string
          tone?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          cadence_by_treatment_type?: Json
          cadence_hours?: number[]
          channel?: string
          created_at?: string
          id?: string
          is_default?: boolean
          name?: string
          tone?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      emma_pricing_plans: {
        Row: {
          created_at: string
          id: string
          monthly_flat_usd: number
          plan: string
          plan_ended_at: string | null
          plan_started_at: string
          revenue_share_pct: number
          stripe_customer_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          monthly_flat_usd?: number
          plan: string
          plan_ended_at?: string | null
          plan_started_at?: string
          revenue_share_pct?: number
          stripe_customer_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          monthly_flat_usd?: number
          plan?: string
          plan_ended_at?: string | null
          plan_started_at?: string
          revenue_share_pct?: number
          stripe_customer_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      emma_recovery_events: {
        Row: {
          appointment_id: string | null
          attributed_revenue_usd: number | null
          attribution_method: string
          created_at: string
          id: string
          matched_transaction_id: string | null
          notes: string | null
          patient_node_id: string | null
          recovery_agent: string
          referred_by_rep_id: string | null
          updated_at: string
          user_id: string
          verification_source: string | null
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          appointment_id?: string | null
          attributed_revenue_usd?: number | null
          attribution_method?: string
          created_at?: string
          id?: string
          matched_transaction_id?: string | null
          notes?: string | null
          patient_node_id?: string | null
          recovery_agent: string
          referred_by_rep_id?: string | null
          updated_at?: string
          user_id: string
          verification_source?: string | null
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          appointment_id?: string | null
          attributed_revenue_usd?: number | null
          attribution_method?: string
          created_at?: string
          id?: string
          matched_transaction_id?: string | null
          notes?: string | null
          patient_node_id?: string | null
          recovery_agent?: string
          referred_by_rep_id?: string | null
          updated_at?: string
          user_id?: string
          verification_source?: string | null
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "emma_recovery_events_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "emma_appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emma_recovery_events_matched_transaction_id_fkey"
            columns: ["matched_transaction_id"]
            isOneToOne: false
            referencedRelation: "patient_transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emma_recovery_events_patient_node_id_fkey"
            columns: ["patient_node_id"]
            isOneToOne: false
            referencedRelation: "knowledge_nodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emma_recovery_events_referred_by_rep_id_fkey"
            columns: ["referred_by_rep_id"]
            isOneToOne: false
            referencedRelation: "rep_accounts"
            referencedColumns: ["rep_user_id"]
          },
        ]
      }
      emma_reliability_runs: {
        Row: {
          completed_at: string
          created_at: string
          id: string
          patients_recomputed: number
          transitions: number
          trigger: string
          user_id: string
        }
        Insert: {
          completed_at: string
          created_at?: string
          id?: string
          patients_recomputed?: number
          transitions?: number
          trigger: string
          user_id: string
        }
        Update: {
          completed_at?: string
          created_at?: string
          id?: string
          patients_recomputed?: number
          transitions?: number
          trigger?: string
          user_id?: string
        }
        Relationships: []
      }
      emma_reliability_status: {
        Row: {
          cancellations_6mo: number
          cancellations_lifetime: number
          created_at: string
          grace_credits_used: number
          id: string
          last_activity_at: string | null
          no_shows_6mo: number
          no_shows_lifetime: number
          patient_node_id: string
          recomputed_at: string
          tier: string
          total_visits: number
          updated_at: string
          user_id: string
        }
        Insert: {
          cancellations_6mo?: number
          cancellations_lifetime?: number
          created_at?: string
          grace_credits_used?: number
          id?: string
          last_activity_at?: string | null
          no_shows_6mo?: number
          no_shows_lifetime?: number
          patient_node_id: string
          recomputed_at?: string
          tier?: string
          total_visits?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          cancellations_6mo?: number
          cancellations_lifetime?: number
          created_at?: string
          grace_credits_used?: number
          id?: string
          last_activity_at?: string | null
          no_shows_6mo?: number
          no_shows_lifetime?: number
          patient_node_id?: string
          recomputed_at?: string
          tier?: string
          total_visits?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "emma_reliability_status_patient_node_id_fkey"
            columns: ["patient_node_id"]
            isOneToOne: false
            referencedRelation: "knowledge_nodes"
            referencedColumns: ["id"]
          },
        ]
      }
      emma_rescue_attempts: {
        Row: {
          closed_at: string | null
          created_at: string
          filled_at: string | null
          filled_by_offer_id: string | null
          freed_appointment_id: string
          id: string
          notes: string | null
          outreach_count: number
          status: string
          triggered_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          closed_at?: string | null
          created_at?: string
          filled_at?: string | null
          filled_by_offer_id?: string | null
          freed_appointment_id: string
          id?: string
          notes?: string | null
          outreach_count?: number
          status?: string
          triggered_at?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          closed_at?: string | null
          created_at?: string
          filled_at?: string | null
          filled_by_offer_id?: string | null
          freed_appointment_id?: string
          id?: string
          notes?: string | null
          outreach_count?: number
          status?: string
          triggered_at?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "emma_rescue_attempts_filled_by_offer_fk"
            columns: ["filled_by_offer_id"]
            isOneToOne: false
            referencedRelation: "emma_rescue_offers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emma_rescue_attempts_freed_appointment_id_fkey"
            columns: ["freed_appointment_id"]
            isOneToOne: false
            referencedRelation: "emma_appointments"
            referencedColumns: ["id"]
          },
        ]
      }
      emma_rescue_offers: {
        Row: {
          appointment_id: string
          claimed_at: string | null
          created_at: string
          declined_at: string | null
          expired_at: string | null
          id: string
          message_id: string | null
          patient_node_id: string
          rescue_attempt_id: string
          send_error: string | null
          sent_at: string
          token: string
          user_id: string
        }
        Insert: {
          appointment_id: string
          claimed_at?: string | null
          created_at?: string
          declined_at?: string | null
          expired_at?: string | null
          id?: string
          message_id?: string | null
          patient_node_id: string
          rescue_attempt_id: string
          send_error?: string | null
          sent_at?: string
          token?: string
          user_id: string
        }
        Update: {
          appointment_id?: string
          claimed_at?: string | null
          created_at?: string
          declined_at?: string | null
          expired_at?: string | null
          id?: string
          message_id?: string | null
          patient_node_id?: string
          rescue_attempt_id?: string
          send_error?: string | null
          sent_at?: string
          token?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "emma_rescue_offers_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "emma_appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emma_rescue_offers_patient_node_id_fkey"
            columns: ["patient_node_id"]
            isOneToOne: false
            referencedRelation: "knowledge_nodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emma_rescue_offers_rescue_attempt_id_fkey"
            columns: ["rescue_attempt_id"]
            isOneToOne: false
            referencedRelation: "emma_rescue_attempts"
            referencedColumns: ["id"]
          },
        ]
      }
      emma_scheduler_connections: {
        Row: {
          access_token: string | null
          connected_at: string | null
          created_at: string
          disconnected_at: string | null
          id: string
          last_error: string | null
          last_sync_at: string | null
          oauth_scope: string | null
          platform: string
          platform_account_email: string | null
          platform_account_id: string | null
          refresh_token: string | null
          status: string
          token_expires_at: string | null
          updated_at: string
          user_id: string
          webhook_secret: string
          webhook_subscription_id: string | null
        }
        Insert: {
          access_token?: string | null
          connected_at?: string | null
          created_at?: string
          disconnected_at?: string | null
          id?: string
          last_error?: string | null
          last_sync_at?: string | null
          oauth_scope?: string | null
          platform: string
          platform_account_email?: string | null
          platform_account_id?: string | null
          refresh_token?: string | null
          status?: string
          token_expires_at?: string | null
          updated_at?: string
          user_id: string
          webhook_secret?: string
          webhook_subscription_id?: string | null
        }
        Update: {
          access_token?: string | null
          connected_at?: string | null
          created_at?: string
          disconnected_at?: string | null
          id?: string
          last_error?: string | null
          last_sync_at?: string | null
          oauth_scope?: string | null
          platform?: string
          platform_account_email?: string | null
          platform_account_id?: string | null
          refresh_token?: string | null
          status?: string
          token_expires_at?: string | null
          updated_at?: string
          user_id?: string
          webhook_secret?: string
          webhook_subscription_id?: string | null
        }
        Relationships: []
      }
      emma_scheduler_webhook_events: {
        Row: {
          connection_id: string
          emma_appointment_id: string | null
          error: string | null
          event_type: string
          external_appointment_id: string | null
          id: string
          platform: string
          processed_at: string | null
          raw_payload: Json
          received_at: string
          user_id: string
        }
        Insert: {
          connection_id: string
          emma_appointment_id?: string | null
          error?: string | null
          event_type: string
          external_appointment_id?: string | null
          id?: string
          platform: string
          processed_at?: string | null
          raw_payload: Json
          received_at?: string
          user_id: string
        }
        Update: {
          connection_id?: string
          emma_appointment_id?: string | null
          error?: string | null
          event_type?: string
          external_appointment_id?: string | null
          id?: string
          platform?: string
          processed_at?: string | null
          raw_payload?: Json
          received_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "emma_scheduler_webhook_events_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "emma_scheduler_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      emma_sender_domains: {
        Row: {
          created_at: string
          dns_records: Json
          domain: string
          from_display_name: string
          from_local_part: string
          id: string
          last_checked_at: string | null
          resend_domain_id: string | null
          status: string
          updated_at: string
          user_id: string
          verified_at: string | null
        }
        Insert: {
          created_at?: string
          dns_records?: Json
          domain: string
          from_display_name?: string
          from_local_part?: string
          id?: string
          last_checked_at?: string | null
          resend_domain_id?: string | null
          status?: string
          updated_at?: string
          user_id: string
          verified_at?: string | null
        }
        Update: {
          created_at?: string
          dns_records?: Json
          domain?: string
          from_display_name?: string
          from_local_part?: string
          id?: string
          last_checked_at?: string | null
          resend_domain_id?: string | null
          status?: string
          updated_at?: string
          user_id?: string
          verified_at?: string | null
        }
        Relationships: []
      }
      emma_setting_benchmarks: {
        Row: {
          computed_at: string
          id: string
          median_monthly_recovery_usd: number | null
          median_recovery_rate: number | null
          sample_size: number
          segment_key: string
          setting_key: string
          setting_value: string
        }
        Insert: {
          computed_at?: string
          id?: string
          median_monthly_recovery_usd?: number | null
          median_recovery_rate?: number | null
          sample_size?: number
          segment_key: string
          setting_key: string
          setting_value: string
        }
        Update: {
          computed_at?: string
          id?: string
          median_monthly_recovery_usd?: number | null
          median_recovery_rate?: number | null
          sample_size?: number
          segment_key?: string
          setting_key?: string
          setting_value?: string
        }
        Relationships: []
      }
      emma_setting_recommendations: {
        Row: {
          applied_at: string | null
          body: string | null
          created_at: string
          current_value: string | null
          dismissed_at: string | null
          dismissed_by: string | null
          generated_at: string
          headline: string
          id: string
          projected_lift_usd: number | null
          rollback_snapshot: Json | null
          setting_key: string
          source: string
          suggested_value: string
          updated_at: string
          user_id: string
        }
        Insert: {
          applied_at?: string | null
          body?: string | null
          created_at?: string
          current_value?: string | null
          dismissed_at?: string | null
          dismissed_by?: string | null
          generated_at?: string
          headline: string
          id?: string
          projected_lift_usd?: number | null
          rollback_snapshot?: Json | null
          setting_key: string
          source: string
          suggested_value: string
          updated_at?: string
          user_id: string
        }
        Update: {
          applied_at?: string | null
          body?: string | null
          created_at?: string
          current_value?: string | null
          dismissed_at?: string | null
          dismissed_by?: string | null
          generated_at?: string
          headline?: string
          id?: string
          projected_lift_usd?: number | null
          rollback_snapshot?: Json | null
          setting_key?: string
          source?: string
          suggested_value?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      emma_waitlist: {
        Row: {
          availability_windows: Json
          created_at: string
          id: string
          intent_type: string
          opt_in_source: string
          opted_in_at: string
          patient_node_id: string
          preferred_providers: string[]
          revoked_at: string | null
          scheduled_appointment_id: string | null
          status: string
          treatment_types: string[]
          updated_at: string
          user_id: string
        }
        Insert: {
          availability_windows?: Json
          created_at?: string
          id?: string
          intent_type?: string
          opt_in_source: string
          opted_in_at?: string
          patient_node_id: string
          preferred_providers?: string[]
          revoked_at?: string | null
          scheduled_appointment_id?: string | null
          status?: string
          treatment_types?: string[]
          updated_at?: string
          user_id: string
        }
        Update: {
          availability_windows?: Json
          created_at?: string
          id?: string
          intent_type?: string
          opt_in_source?: string
          opted_in_at?: string
          patient_node_id?: string
          preferred_providers?: string[]
          revoked_at?: string | null
          scheduled_appointment_id?: string | null
          status?: string
          treatment_types?: string[]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "emma_waitlist_patient_node_id_fkey"
            columns: ["patient_node_id"]
            isOneToOne: false
            referencedRelation: "knowledge_nodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emma_waitlist_scheduled_appointment_id_fkey"
            columns: ["scheduled_appointment_id"]
            isOneToOne: false
            referencedRelation: "emma_appointments"
            referencedColumns: ["id"]
          },
        ]
      }
      emma_waitlist_tokens: {
        Row: {
          created_at: string
          last_used_at: string | null
          patient_node_id: string
          token: string
          user_id: string
        }
        Insert: {
          created_at?: string
          last_used_at?: string | null
          patient_node_id: string
          token?: string
          user_id: string
        }
        Update: {
          created_at?: string
          last_used_at?: string | null
          patient_node_id?: string
          token?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "emma_waitlist_tokens_patient_node_id_fkey"
            columns: ["patient_node_id"]
            isOneToOne: false
            referencedRelation: "knowledge_nodes"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_flags: {
        Row: {
          enabled: boolean
          flag_key: string
          id: string
          metadata: Json | null
          scope: string
          scope_id: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          enabled?: boolean
          flag_key: string
          id?: string
          metadata?: Json | null
          scope: string
          scope_id?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          enabled?: boolean
          flag_key?: string
          id?: string
          metadata?: Json | null
          scope?: string
          scope_id?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      inbox_unmatched: {
        Row: {
          body_html: string | null
          body_text: string | null
          created_at: string
          from_addr: string
          id: string
          raw_headers: Json
          received_at: string
          resend_email_id: string
          resolved_at: string | null
          resolved_outreach_id: string | null
          subject: string | null
          to_addr: string
          user_id: string
        }
        Insert: {
          body_html?: string | null
          body_text?: string | null
          created_at?: string
          from_addr: string
          id?: string
          raw_headers?: Json
          received_at?: string
          resend_email_id: string
          resolved_at?: string | null
          resolved_outreach_id?: string | null
          subject?: string | null
          to_addr: string
          user_id: string
        }
        Update: {
          body_html?: string | null
          body_text?: string | null
          created_at?: string
          from_addr?: string
          id?: string
          raw_headers?: Json
          received_at?: string
          resend_email_id?: string
          resolved_at?: string | null
          resolved_outreach_id?: string | null
          subject?: string | null
          to_addr?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inbox_unmatched_resolved_outreach_id_fkey"
            columns: ["resolved_outreach_id"]
            isOneToOne: false
            referencedRelation: "promotion_outreach"
            referencedColumns: ["id"]
          },
        ]
      }
      incentive_offers: {
        Row: {
          claimed_at: string | null
          created_at: string
          created_by: string | null
          id: string
          offer_type: string
          source_drip_event_id: string | null
          tenant_id: string | null
          terms: Json
          valid_from: string
          valid_until: string | null
        }
        Insert: {
          claimed_at?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          offer_type: string
          source_drip_event_id?: string | null
          tenant_id?: string | null
          terms?: Json
          valid_from?: string
          valid_until?: string | null
        }
        Update: {
          claimed_at?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          offer_type?: string
          source_drip_event_id?: string | null
          tenant_id?: string | null
          terms?: Json
          valid_from?: string
          valid_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "incentive_offers_source_drip_event_id_fkey"
            columns: ["source_drip_event_id"]
            isOneToOne: false
            referencedRelation: "tenant_engagement_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incentive_offers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_nodes: {
        Row: {
          attachments: Json
          content: string
          context: string | null
          created_at: string
          id: string
          last_referenced_at: string
          lookup_key: string | null
          lookup_type: string | null
          node_type: string
          source: string | null
          source_ref: string | null
          title: string
          updated_at: string
          user_id: string
          weight: number
        }
        Insert: {
          attachments?: Json
          content: string
          context?: string | null
          created_at?: string
          id?: string
          last_referenced_at?: string
          lookup_key?: string | null
          lookup_type?: string | null
          node_type: string
          source?: string | null
          source_ref?: string | null
          title: string
          updated_at?: string
          user_id: string
          weight?: number
        }
        Update: {
          attachments?: Json
          content?: string
          context?: string | null
          created_at?: string
          id?: string
          last_referenced_at?: string
          lookup_key?: string | null
          lookup_type?: string | null
          node_type?: string
          source?: string | null
          source_ref?: string | null
          title?: string
          updated_at?: string
          user_id?: string
          weight?: number
        }
        Relationships: []
      }
      outreach_drafts: {
        Row: {
          audience: string
          batch_label: string | null
          body_override: string | null
          channel: string
          contact_id: string | null
          created_at: string
          icp: number
          id: string
          recipient_email: string
          recipient_first_name: string | null
          rep_user_id: string
          sent_at: string | null
          sent_event_id: string | null
          spa_name: string | null
          subject_override: string | null
          template_id: string
          updated_at: string
        }
        Insert: {
          audience?: string
          batch_label?: string | null
          body_override?: string | null
          channel: string
          contact_id?: string | null
          created_at?: string
          icp: number
          id?: string
          recipient_email: string
          recipient_first_name?: string | null
          rep_user_id: string
          sent_at?: string | null
          sent_event_id?: string | null
          spa_name?: string | null
          subject_override?: string | null
          template_id: string
          updated_at?: string
        }
        Update: {
          audience?: string
          batch_label?: string | null
          body_override?: string | null
          channel?: string
          contact_id?: string | null
          created_at?: string
          icp?: number
          id?: string
          recipient_email?: string
          recipient_first_name?: string | null
          rep_user_id?: string
          sent_at?: string | null
          sent_event_id?: string | null
          spa_name?: string | null
          subject_override?: string | null
          template_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "outreach_drafts_sent_event_id_fkey"
            columns: ["sent_event_id"]
            isOneToOne: false
            referencedRelation: "outreach_engagement_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outreach_drafts_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "outreach_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      outreach_engagement_events: {
        Row: {
          channel: string
          clicked_at: string | null
          converted_at: string | null
          converted_rep_user_id: string | null
          converted_tenant_id: string | null
          created_at: string
          icp: number
          id: string
          opened_at: string | null
          purpose: string
          recipient_email: string
          recipient_first_name: string | null
          recipient_last_name: string | null
          rendered_body: string
          rendered_subject: string | null
          resend_email_id: string | null
          response_received_at: string | null
          response_text: string | null
          send_mode: string
          sent_at: string
          sent_by: string | null
          source_context: string | null
          template_id: string | null
        }
        Insert: {
          channel: string
          clicked_at?: string | null
          converted_at?: string | null
          converted_rep_user_id?: string | null
          converted_tenant_id?: string | null
          created_at?: string
          icp: number
          id?: string
          opened_at?: string | null
          purpose?: string
          recipient_email: string
          recipient_first_name?: string | null
          recipient_last_name?: string | null
          rendered_body: string
          rendered_subject?: string | null
          resend_email_id?: string | null
          response_received_at?: string | null
          response_text?: string | null
          send_mode: string
          sent_at?: string
          sent_by?: string | null
          source_context?: string | null
          template_id?: string | null
        }
        Update: {
          channel?: string
          clicked_at?: string | null
          converted_at?: string | null
          converted_rep_user_id?: string | null
          converted_tenant_id?: string | null
          created_at?: string
          icp?: number
          id?: string
          opened_at?: string | null
          purpose?: string
          recipient_email?: string
          recipient_first_name?: string | null
          recipient_last_name?: string | null
          rendered_body?: string
          rendered_subject?: string | null
          resend_email_id?: string | null
          response_received_at?: string | null
          response_text?: string | null
          send_mode?: string
          sent_at?: string
          sent_by?: string | null
          source_context?: string | null
          template_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "outreach_engagement_events_converted_rep_user_id_fkey"
            columns: ["converted_rep_user_id"]
            isOneToOne: false
            referencedRelation: "rep_accounts"
            referencedColumns: ["rep_user_id"]
          },
          {
            foreignKeyName: "outreach_engagement_events_converted_tenant_id_fkey"
            columns: ["converted_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outreach_engagement_events_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "outreach_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      outreach_templates: {
        Row: {
          audience: string
          body: string
          channel: string
          created_at: string
          created_by: string | null
          icp: number
          id: string
          is_active: boolean
          loom_url: string | null
          name: string | null
          notes: string | null
          owner_rep_user_id: string | null
          subject: string | null
          updated_at: string
          version: number
        }
        Insert: {
          audience?: string
          body: string
          channel: string
          created_at?: string
          created_by?: string | null
          icp: number
          id?: string
          is_active?: boolean
          loom_url?: string | null
          name?: string | null
          notes?: string | null
          owner_rep_user_id?: string | null
          subject?: string | null
          updated_at?: string
          version?: number
        }
        Update: {
          audience?: string
          body?: string
          channel?: string
          created_at?: string
          created_by?: string | null
          icp?: number
          id?: string
          is_active?: boolean
          loom_url?: string | null
          name?: string | null
          notes?: string | null
          owner_rep_user_id?: string | null
          subject?: string | null
          updated_at?: string
          version?: number
        }
        Relationships: []
      }
      patient_contact_candidates: {
        Row: {
          banned: boolean
          created_at: string
          days_since_last_appointment: number | null
          display_name: string
          email: string | null
          first_name: string | null
          id: string
          imported_at: string
          last_name: string | null
          linked_at: string | null
          linked_patient_node_id: string | null
          normalized_name: string
          notes: string | null
          phone: string | null
          phone_raw: string | null
          source_filename: string | null
          source_row: number | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          banned?: boolean
          created_at?: string
          days_since_last_appointment?: number | null
          display_name: string
          email?: string | null
          first_name?: string | null
          id?: string
          imported_at?: string
          last_name?: string | null
          linked_at?: string | null
          linked_patient_node_id?: string | null
          normalized_name: string
          notes?: string | null
          phone?: string | null
          phone_raw?: string | null
          source_filename?: string | null
          source_row?: number | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          banned?: boolean
          created_at?: string
          days_since_last_appointment?: number | null
          display_name?: string
          email?: string | null
          first_name?: string | null
          id?: string
          imported_at?: string
          last_name?: string | null
          linked_at?: string | null
          linked_patient_node_id?: string | null
          normalized_name?: string
          notes?: string | null
          phone?: string | null
          phone_raw?: string | null
          source_filename?: string | null
          source_row?: number | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "patient_contact_candidates_linked_patient_node_id_fkey"
            columns: ["linked_patient_node_id"]
            isOneToOne: false
            referencedRelation: "knowledge_nodes"
            referencedColumns: ["id"]
          },
        ]
      }
      patient_outreach: {
        Row: {
          body: string
          channel: string
          created_at: string
          direction: string
          id: string
          intent_token: string | null
          message_id: string | null
          opened_at: string | null
          patient_outreach_state_id: string
          read_at: string | null
          replied_at: string | null
          sent_at: string | null
          skip_reason: string | null
          subject: string | null
          user_id: string
        }
        Insert: {
          body: string
          channel: string
          created_at?: string
          direction: string
          id?: string
          intent_token?: string | null
          message_id?: string | null
          opened_at?: string | null
          patient_outreach_state_id: string
          read_at?: string | null
          replied_at?: string | null
          sent_at?: string | null
          skip_reason?: string | null
          subject?: string | null
          user_id: string
        }
        Update: {
          body?: string
          channel?: string
          created_at?: string
          direction?: string
          id?: string
          intent_token?: string | null
          message_id?: string | null
          opened_at?: string | null
          patient_outreach_state_id?: string
          read_at?: string | null
          replied_at?: string | null
          sent_at?: string | null
          skip_reason?: string | null
          subject?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "patient_outreach_patient_outreach_state_id_fkey"
            columns: ["patient_outreach_state_id"]
            isOneToOne: false
            referencedRelation: "patient_outreach_state"
            referencedColumns: ["id"]
          },
        ]
      }
      patient_outreach_state: {
        Row: {
          attributed_revenue_usd: number | null
          booking_confirmed_at: string | null
          booking_intent_token: string | null
          campaign_node_id: string
          channel: string | null
          created_at: string
          draft: Json
          id: string
          last_message_id: string | null
          last_touched_at: string | null
          nudge_dismissed_at: string | null
          patient_node_id: string
          scheduled_at: string | null
          showed_at: string | null
          state: string
          updated_at: string
          user_id: string
        }
        Insert: {
          attributed_revenue_usd?: number | null
          booking_confirmed_at?: string | null
          booking_intent_token?: string | null
          campaign_node_id: string
          channel?: string | null
          created_at?: string
          draft?: Json
          id?: string
          last_message_id?: string | null
          last_touched_at?: string | null
          nudge_dismissed_at?: string | null
          patient_node_id: string
          scheduled_at?: string | null
          showed_at?: string | null
          state?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          attributed_revenue_usd?: number | null
          booking_confirmed_at?: string | null
          booking_intent_token?: string | null
          campaign_node_id?: string
          channel?: string | null
          created_at?: string
          draft?: Json
          id?: string
          last_message_id?: string | null
          last_touched_at?: string | null
          nudge_dismissed_at?: string | null
          patient_node_id?: string
          scheduled_at?: string | null
          showed_at?: string | null
          state?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "patient_outreach_state_campaign_node_id_fkey"
            columns: ["campaign_node_id"]
            isOneToOne: false
            referencedRelation: "knowledge_nodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_outreach_state_patient_node_id_fkey"
            columns: ["patient_node_id"]
            isOneToOne: false
            referencedRelation: "knowledge_nodes"
            referencedColumns: ["id"]
          },
        ]
      }
      patient_transactions: {
        Row: {
          amount_usd: number
          balance_usd: number | null
          created_at: string
          description: string | null
          id: string
          invoice_num: string | null
          line_index: number
          patient_node_id: string
          product_kind: string | null
          product_manufacturer: string | null
          product_name: string
          quantity: number | null
          source: string
          source_ref: string | null
          transaction_date: string
          unit_price_usd: number | null
          user_id: string
        }
        Insert: {
          amount_usd: number
          balance_usd?: number | null
          created_at?: string
          description?: string | null
          id?: string
          invoice_num?: string | null
          line_index?: number
          patient_node_id: string
          product_kind?: string | null
          product_manufacturer?: string | null
          product_name: string
          quantity?: number | null
          source?: string
          source_ref?: string | null
          transaction_date: string
          unit_price_usd?: number | null
          user_id: string
        }
        Update: {
          amount_usd?: number
          balance_usd?: number | null
          created_at?: string
          description?: string | null
          id?: string
          invoice_num?: string | null
          line_index?: number
          patient_node_id?: string
          product_kind?: string | null
          product_manufacturer?: string | null
          product_name?: string
          quantity?: number | null
          source?: string
          source_ref?: string | null
          transaction_date?: string
          unit_price_usd?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "patient_transactions_patient_node_id_fkey"
            columns: ["patient_node_id"]
            isOneToOne: false
            referencedRelation: "knowledge_nodes"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          brand: string
          category: string
          cost_per_unit: number
          created_at: string
          hidden_at: string | null
          id: string
          manufacturer: string | null
          notes: string | null
          sales_price_per_unit: number
          tenant_id: string
          unit_type: string
          updated_at: string
        }
        Insert: {
          brand: string
          category: string
          cost_per_unit: number
          created_at?: string
          hidden_at?: string | null
          id?: string
          manufacturer?: string | null
          notes?: string | null
          sales_price_per_unit: number
          tenant_id: string
          unit_type: string
          updated_at?: string
        }
        Update: {
          brand?: string
          category?: string
          cost_per_unit?: number
          created_at?: string
          hidden_at?: string | null
          id?: string
          manufacturer?: string | null
          notes?: string | null
          sales_price_per_unit?: number
          tenant_id?: string
          unit_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "products_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      promo_intents: {
        Row: {
          account_node_id: string | null
          confirmed_at: string | null
          confirmed_by_name: string | null
          confirmed_note: string | null
          confirmed_tier_code: string | null
          confirmed_units: number | null
          first_viewed_at: string | null
          id: string
          last_viewed_at: string | null
          practice_email: string
          promotion_node_id: string | null
          rep_email: string | null
          rep_name: string
          rep_user_id: string
          revoked_at: string | null
          sent_at: string
          snapshot: Json
          token: string
          view_count: number
        }
        Insert: {
          account_node_id?: string | null
          confirmed_at?: string | null
          confirmed_by_name?: string | null
          confirmed_note?: string | null
          confirmed_tier_code?: string | null
          confirmed_units?: number | null
          first_viewed_at?: string | null
          id?: string
          last_viewed_at?: string | null
          practice_email: string
          promotion_node_id?: string | null
          rep_email?: string | null
          rep_name: string
          rep_user_id: string
          revoked_at?: string | null
          sent_at?: string
          snapshot: Json
          token: string
          view_count?: number
        }
        Update: {
          account_node_id?: string | null
          confirmed_at?: string | null
          confirmed_by_name?: string | null
          confirmed_note?: string | null
          confirmed_tier_code?: string | null
          confirmed_units?: number | null
          first_viewed_at?: string | null
          id?: string
          last_viewed_at?: string | null
          practice_email?: string
          promotion_node_id?: string | null
          rep_email?: string | null
          rep_name?: string
          rep_user_id?: string
          revoked_at?: string | null
          sent_at?: string
          snapshot?: Json
          token?: string
          view_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "promo_intents_account_node_id_fkey"
            columns: ["account_node_id"]
            isOneToOne: false
            referencedRelation: "knowledge_nodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promo_intents_promotion_node_id_fkey"
            columns: ["promotion_node_id"]
            isOneToOne: false
            referencedRelation: "knowledge_nodes"
            referencedColumns: ["id"]
          },
        ]
      }
      promotion_account_state: {
        Row: {
          account_node_id: string
          committed_tier_code: string | null
          committed_units: number | null
          created_at: string
          fulfillment_issues: Json
          id: string
          last_touched_at: string | null
          nudge_dismissed_at: string | null
          order_invoice_number: string | null
          order_placed_at: string | null
          order_total_usd: number | null
          promotion_node_id: string
          rep_notes: string | null
          state: string
          updated_at: string
          user_id: string
        }
        Insert: {
          account_node_id: string
          committed_tier_code?: string | null
          committed_units?: number | null
          created_at?: string
          fulfillment_issues?: Json
          id?: string
          last_touched_at?: string | null
          nudge_dismissed_at?: string | null
          order_invoice_number?: string | null
          order_placed_at?: string | null
          order_total_usd?: number | null
          promotion_node_id: string
          rep_notes?: string | null
          state?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          account_node_id?: string
          committed_tier_code?: string | null
          committed_units?: number | null
          created_at?: string
          fulfillment_issues?: Json
          id?: string
          last_touched_at?: string | null
          nudge_dismissed_at?: string | null
          order_invoice_number?: string | null
          order_placed_at?: string | null
          order_total_usd?: number | null
          promotion_node_id?: string
          rep_notes?: string | null
          state?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "promotion_account_state_account_node_id_fkey"
            columns: ["account_node_id"]
            isOneToOne: false
            referencedRelation: "knowledge_nodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promotion_account_state_promotion_node_id_fkey"
            columns: ["promotion_node_id"]
            isOneToOne: false
            referencedRelation: "knowledge_nodes"
            referencedColumns: ["id"]
          },
        ]
      }
      promotion_fulfillment_issue: {
        Row: {
          created_at: string
          description: string
          id: string
          kind: string
          reported_at: string
          reported_via: string | null
          resolution_notes: string | null
          resolved_at: string | null
          severity: string
          state_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          description: string
          id?: string
          kind: string
          reported_at?: string
          reported_via?: string | null
          resolution_notes?: string | null
          resolved_at?: string | null
          severity?: string
          state_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          kind?: string
          reported_at?: string
          reported_via?: string | null
          resolution_notes?: string | null
          resolved_at?: string | null
          severity?: string
          state_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "promotion_fulfillment_issue_state_id_fkey"
            columns: ["state_id"]
            isOneToOne: false
            referencedRelation: "promotion_account_state"
            referencedColumns: ["id"]
          },
        ]
      }
      promotion_outreach: {
        Row: {
          auto_draft_body: string | null
          auto_draft_generated_at: string | null
          auto_draft_subject: string | null
          auto_draft_verified: Json | null
          body: string
          created_at: string
          direction: string
          email_id: string | null
          id: string
          in_reply_to: string | null
          intent_token: string | null
          kind: string
          metadata: Json
          opened_at: string | null
          read_at: string | null
          responded_at: string | null
          response_body: string | null
          sent_at: string
          state_id: string
          subject: string | null
          user_id: string
        }
        Insert: {
          auto_draft_body?: string | null
          auto_draft_generated_at?: string | null
          auto_draft_subject?: string | null
          auto_draft_verified?: Json | null
          body?: string
          created_at?: string
          direction: string
          email_id?: string | null
          id?: string
          in_reply_to?: string | null
          intent_token?: string | null
          kind: string
          metadata?: Json
          opened_at?: string | null
          read_at?: string | null
          responded_at?: string | null
          response_body?: string | null
          sent_at?: string
          state_id: string
          subject?: string | null
          user_id: string
        }
        Update: {
          auto_draft_body?: string | null
          auto_draft_generated_at?: string | null
          auto_draft_subject?: string | null
          auto_draft_verified?: Json | null
          body?: string
          created_at?: string
          direction?: string
          email_id?: string | null
          id?: string
          in_reply_to?: string | null
          intent_token?: string | null
          kind?: string
          metadata?: Json
          opened_at?: string | null
          read_at?: string | null
          responded_at?: string | null
          response_body?: string | null
          sent_at?: string
          state_id?: string
          subject?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "promotion_outreach_state_id_fkey"
            columns: ["state_id"]
            isOneToOne: false
            referencedRelation: "promotion_account_state"
            referencedColumns: ["id"]
          },
        ]
      }
      public_csv_dialect_cache: {
        Row: {
          alias_map: Json
          created_at: string
          detected_platform: string | null
          header_hash: string
          id: string
          llm_at: string
          llm_model: string
          scan_count: number
          updated_at: string
        }
        Insert: {
          alias_map: Json
          created_at?: string
          detected_platform?: string | null
          header_hash: string
          id?: string
          llm_at?: string
          llm_model: string
          scan_count?: number
          updated_at?: string
        }
        Update: {
          alias_map?: Json
          created_at?: string
          detected_platform?: string | null
          header_hash?: string
          id?: string
          llm_at?: string
          llm_model?: string
          scan_count?: number
          updated_at?: string
        }
        Relationships: []
      }
      rebate_inventory_units: {
        Row: {
          created_at: string
          id: string
          node_id: string
          soft_deleted_at: string | null
          units_deployed: number
          units_total: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          node_id: string
          soft_deleted_at?: string | null
          units_deployed?: number
          units_total: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          node_id?: string
          soft_deleted_at?: string | null
          units_deployed?: number
          units_total?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rebate_inventory_units_node_id_fkey"
            columns: ["node_id"]
            isOneToOne: true
            referencedRelation: "knowledge_nodes"
            referencedColumns: ["id"]
          },
        ]
      }
      refill_invoices: {
        Row: {
          created_at: string
          generated_at: string
          id: string
          monthly_flat_usd: number
          notes: string | null
          paid_at: string | null
          period_end: string
          period_start: string
          plan_at_invoice: string
          recovered_revenue_count: number
          recovered_revenue_usd: number
          referred_by_rep_id: string | null
          revenue_share_pct: number
          sent_at: string | null
          share_due_usd: number
          status: string
          stripe_invoice_id: string | null
          tenant_id: string
          total_due_usd: number
          updated_at: string
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          created_at?: string
          generated_at?: string
          id?: string
          monthly_flat_usd: number
          notes?: string | null
          paid_at?: string | null
          period_end: string
          period_start: string
          plan_at_invoice: string
          recovered_revenue_count?: number
          recovered_revenue_usd?: number
          referred_by_rep_id?: string | null
          revenue_share_pct: number
          sent_at?: string | null
          share_due_usd?: number
          status?: string
          stripe_invoice_id?: string | null
          tenant_id: string
          total_due_usd?: number
          updated_at?: string
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          created_at?: string
          generated_at?: string
          id?: string
          monthly_flat_usd?: number
          notes?: string | null
          paid_at?: string | null
          period_end?: string
          period_start?: string
          plan_at_invoice?: string
          recovered_revenue_count?: number
          recovered_revenue_usd?: number
          referred_by_rep_id?: string | null
          revenue_share_pct?: number
          sent_at?: string | null
          share_due_usd?: number
          status?: string
          stripe_invoice_id?: string | null
          tenant_id?: string
          total_due_usd?: number
          updated_at?: string
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "refill_invoices_referred_by_rep_id_fkey"
            columns: ["referred_by_rep_id"]
            isOneToOne: false
            referencedRelation: "rep_accounts"
            referencedColumns: ["rep_user_id"]
          },
          {
            foreignKeyName: "refill_invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      refill_pricing_plans: {
        Row: {
          created_at: string
          id: string
          monthly_flat_usd: number
          plan: string
          plan_ended_at: string | null
          plan_started_at: string
          revenue_share_pct: number
          stripe_customer_id: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          monthly_flat_usd?: number
          plan: string
          plan_ended_at?: string | null
          plan_started_at?: string
          revenue_share_pct?: number
          stripe_customer_id?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          monthly_flat_usd?: number
          plan?: string
          plan_ended_at?: string | null
          plan_started_at?: string
          revenue_share_pct?: number
          stripe_customer_id?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "refill_pricing_plans_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      rep_accounts: {
        Row: {
          business_name: string | null
          created_at: string
          display_name: string
          joined_at: string
          metadata: Json | null
          origin_type: string
          payout_method: string | null
          rep_user_id: string
          status: string
          stripe_account_id: string | null
          territory: Json | null
          updated_at: string
        }
        Insert: {
          business_name?: string | null
          created_at?: string
          display_name: string
          joined_at?: string
          metadata?: Json | null
          origin_type?: string
          payout_method?: string | null
          rep_user_id: string
          status?: string
          stripe_account_id?: string | null
          territory?: Json | null
          updated_at?: string
        }
        Update: {
          business_name?: string | null
          created_at?: string
          display_name?: string
          joined_at?: string
          metadata?: Json | null
          origin_type?: string
          payout_method?: string | null
          rep_user_id?: string
          status?: string
          stripe_account_id?: string | null
          territory?: Json | null
          updated_at?: string
        }
        Relationships: []
      }
      rep_affiliations: {
        Row: {
          active: boolean
          commission_split: number
          created_at: string
          id: string
          parent_rep_id: string | null
          rep_id: string
          tier_level: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          commission_split: number
          created_at?: string
          id?: string
          parent_rep_id?: string | null
          rep_id: string
          tier_level: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          commission_split?: number
          created_at?: string
          id?: string
          parent_rep_id?: string | null
          rep_id?: string
          tier_level?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rep_affiliations_parent_rep_id_fkey"
            columns: ["parent_rep_id"]
            isOneToOne: false
            referencedRelation: "rep_accounts"
            referencedColumns: ["rep_user_id"]
          },
          {
            foreignKeyName: "rep_affiliations_rep_id_fkey"
            columns: ["rep_id"]
            isOneToOne: false
            referencedRelation: "rep_accounts"
            referencedColumns: ["rep_user_id"]
          },
        ]
      }
      rep_commission_ledger: {
        Row: {
          commission_split: number
          commission_usd: number
          created_at: string
          id: string
          notes: string | null
          paid_at: string | null
          period_month: string
          rep_id: string
          source_invoice_id: string | null
          source_revenue_usd: number
          source_tenant_id: string | null
          status: string
          stripe_payout_id: string | null
          tier_level: number
          updated_at: string
        }
        Insert: {
          commission_split: number
          commission_usd: number
          created_at?: string
          id?: string
          notes?: string | null
          paid_at?: string | null
          period_month: string
          rep_id: string
          source_invoice_id?: string | null
          source_revenue_usd: number
          source_tenant_id?: string | null
          status?: string
          stripe_payout_id?: string | null
          tier_level: number
          updated_at?: string
        }
        Update: {
          commission_split?: number
          commission_usd?: number
          created_at?: string
          id?: string
          notes?: string | null
          paid_at?: string | null
          period_month?: string
          rep_id?: string
          source_invoice_id?: string | null
          source_revenue_usd?: number
          source_tenant_id?: string | null
          status?: string
          stripe_payout_id?: string | null
          tier_level?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rep_commission_ledger_rep_id_fkey"
            columns: ["rep_id"]
            isOneToOne: false
            referencedRelation: "rep_accounts"
            referencedColumns: ["rep_user_id"]
          },
          {
            foreignKeyName: "rep_commission_ledger_source_invoice_id_fkey"
            columns: ["source_invoice_id"]
            isOneToOne: false
            referencedRelation: "refill_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rep_commission_ledger_source_tenant_id_fkey"
            columns: ["source_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      rep_referral_links: {
        Row: {
          created_at: string
          id: string
          last_used_at: string | null
          rep_user_id: string
          short_slug: string
          token: string
          use_count: number
        }
        Insert: {
          created_at?: string
          id?: string
          last_used_at?: string | null
          rep_user_id: string
          short_slug: string
          token: string
          use_count?: number
        }
        Update: {
          created_at?: string
          id?: string
          last_used_at?: string | null
          rep_user_id?: string
          short_slug?: string
          token?: string
          use_count?: number
        }
        Relationships: []
      }
      report_rows: {
        Row: {
          content_hash: string
          created_at: string
          data: Json
          id: string
          lookup_key: string
          report_upload_id: string
          source_row: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          content_hash: string
          created_at?: string
          data: Json
          id?: string
          lookup_key: string
          report_upload_id: string
          source_row?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          content_hash?: string
          created_at?: string
          data?: Json
          id?: string
          lookup_key?: string
          report_upload_id?: string
          source_row?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_rows_report_upload_id_fkey"
            columns: ["report_upload_id"]
            isOneToOne: false
            referencedRelation: "report_uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      report_uploads: {
        Row: {
          column_mapping: Json
          created_at: string
          id: string
          last_diff_summary: Json
          last_uploaded_at: string | null
          prior_snapshot: Json | null
          report_key: string
          report_label: string
          report_type: string | null
          row_count: number
          source_filename: string | null
          undo_expires_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          column_mapping?: Json
          created_at?: string
          id?: string
          last_diff_summary?: Json
          last_uploaded_at?: string | null
          prior_snapshot?: Json | null
          report_key: string
          report_label: string
          report_type?: string | null
          row_count?: number
          source_filename?: string | null
          undo_expires_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          column_mapping?: Json
          created_at?: string
          id?: string
          last_diff_summary?: Json
          last_uploaded_at?: string | null
          prior_snapshot?: Json | null
          report_key?: string
          report_label?: string
          report_type?: string | null
          row_count?: number
          source_filename?: string | null
          undo_expires_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      sample_order_intents: {
        Row: {
          confirmed_at: string | null
          confirmed_by_name: string | null
          confirmed_note: string | null
          first_viewed_at: string | null
          id: string
          last_viewed_at: string | null
          order_snapshot: Json
          practice_email: string
          rep_email: string | null
          rep_name: string
          rep_user_id: string
          revoked_at: string | null
          sent_at: string
          token: string
          turn_id: string | null
          view_count: number
        }
        Insert: {
          confirmed_at?: string | null
          confirmed_by_name?: string | null
          confirmed_note?: string | null
          first_viewed_at?: string | null
          id?: string
          last_viewed_at?: string | null
          order_snapshot: Json
          practice_email: string
          rep_email?: string | null
          rep_name: string
          rep_user_id: string
          revoked_at?: string | null
          sent_at?: string
          token: string
          turn_id?: string | null
          view_count?: number
        }
        Update: {
          confirmed_at?: string | null
          confirmed_by_name?: string | null
          confirmed_note?: string | null
          first_viewed_at?: string | null
          id?: string
          last_viewed_at?: string | null
          order_snapshot?: Json
          practice_email?: string
          rep_email?: string | null
          rep_name?: string
          rep_user_id?: string
          revoked_at?: string | null
          sent_at?: string
          token?: string
          turn_id?: string | null
          view_count?: number
        }
        Relationships: []
      }
      service_products: {
        Row: {
          created_at: string
          id: string
          product_id: string
          quantity_per_service: number
          service_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          product_id: string
          quantity_per_service: number
          service_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          product_id?: string
          quantity_per_service?: number
          service_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_products_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_products_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      scheduling_billable_events: {
        Row: {
          amount_cents: number
          appointment_id: string
          created_at: string
          id: string
          invoiced_at: string | null
          occurred_at: string
          tenant_id: string
          type: string
          updated_at: string
        }
        Insert: {
          amount_cents?: number
          appointment_id: string
          created_at?: string
          id?: string
          invoiced_at?: string | null
          occurred_at?: string
          tenant_id: string
          type: string
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          appointment_id?: string
          created_at?: string
          id?: string
          invoiced_at?: string | null
          occurred_at?: string
          tenant_id?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "scheduling_billable_events_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "emma_appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduling_billable_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      scheduling_blocks: {
        Row: {
          created_at: string
          during: string
          id: string
          provider_id: string | null
          reason: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          during: string
          id?: string
          provider_id?: string | null
          reason?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          during?: string
          id?: string
          provider_id?: string | null
          reason?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "scheduling_blocks_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "scheduling_providers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduling_blocks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      scheduling_hours: {
        Row: {
          close_time: string
          created_at: string
          day_of_week: number
          id: string
          is_closed: boolean
          open_time: string
          provider_id: string
          updated_at: string
        }
        Insert: {
          close_time: string
          created_at?: string
          day_of_week: number
          id?: string
          is_closed?: boolean
          open_time: string
          provider_id: string
          updated_at?: string
        }
        Update: {
          close_time?: string
          created_at?: string
          day_of_week?: number
          id?: string
          is_closed?: boolean
          open_time?: string
          provider_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "scheduling_hours_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "scheduling_providers"
            referencedColumns: ["id"]
          },
        ]
      }
      scheduling_providers: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          name: string
          tenant_id: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          tenant_id: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          tenant_id?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scheduling_providers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      scheduling_provider_services: {
        Row: {
          buffer_min: number | null
          created_at: string
          duration_min: number | null
          id: string
          offered: boolean
          price: number | null
          provider_id: string
          service_id: string
          updated_at: string
        }
        Insert: {
          buffer_min?: number | null
          created_at?: string
          duration_min?: number | null
          id?: string
          offered?: boolean
          price?: number | null
          provider_id: string
          service_id: string
          updated_at?: string
        }
        Update: {
          buffer_min?: number | null
          created_at?: string
          duration_min?: number | null
          id?: string
          offered?: boolean
          price?: number | null
          provider_id?: string
          service_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "scheduling_provider_services_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "scheduling_providers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduling_provider_services_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      scheduling_reminder_sends: {
        Row: {
          appointment_id: string
          id: string
          kind: string
          sent_at: string
        }
        Insert: {
          appointment_id: string
          id?: string
          kind: string
          sent_at?: string
        }
        Update: {
          appointment_id?: string
          id?: string
          kind?: string
          sent_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "scheduling_reminder_sends_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "emma_appointments"
            referencedColumns: ["id"]
          },
        ]
      }
      scheduling_resources: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          name: string
          tenant_id: string
          type: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          tenant_id: string
          type?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          tenant_id?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "scheduling_resources_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      scheduling_settings: {
        Row: {
          booking_lead_option: string
          created_at: string
          hold_minutes: number
          id: string
          max_advance_days: number
          min_advance_notice_min: number
          online_booking_enabled: boolean
          reminder_lead_hours: number
          sameday_reminder_enabled: boolean
          slot_granularity_min: number
          tenant_id: string
          timezone: string
          updated_at: string
        }
        Insert: {
          booking_lead_option?: string
          created_at?: string
          hold_minutes?: number
          id?: string
          max_advance_days?: number
          min_advance_notice_min?: number
          online_booking_enabled?: boolean
          reminder_lead_hours?: number
          sameday_reminder_enabled?: boolean
          slot_granularity_min?: number
          tenant_id: string
          timezone?: string
          updated_at?: string
        }
        Update: {
          booking_lead_option?: string
          created_at?: string
          hold_minutes?: number
          id?: string
          max_advance_days?: number
          min_advance_notice_min?: number
          online_booking_enabled?: boolean
          reminder_lead_hours?: number
          sameday_reminder_enabled?: boolean
          slot_granularity_min?: number
          tenant_id?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "scheduling_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      services: {
        Row: {
          buffer_min: number
          category: string
          cogs_per_service: number | null
          cogs_source: string
          created_at: string
          duration_min: number
          hidden_at: string | null
          id: string
          name: string
          notes: string | null
          online_bookable: boolean
          service_price: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          buffer_min?: number
          category: string
          cogs_per_service?: number | null
          cogs_source?: string
          created_at?: string
          duration_min?: number
          hidden_at?: string | null
          id?: string
          name: string
          notes?: string | null
          online_bookable?: boolean
          service_price: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          buffer_min?: number
          category?: string
          cogs_per_service?: number | null
          cogs_source?: string
          created_at?: string
          duration_min?: number
          hidden_at?: string | null
          id?: string
          name?: string
          notes?: string | null
          online_bookable?: boolean
          service_price?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "services_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      spa_claim_sessions: {
        Row: {
          claimed_at: string | null
          claimed_by: string | null
          created_at: string
          id: string
          scrape_data: Json | null
          scrape_error: string | null
          scrape_status: string
          spa_name: string | null
          spa_url: string
          updated_at: string
        }
        Insert: {
          claimed_at?: string | null
          claimed_by?: string | null
          created_at?: string
          id?: string
          scrape_data?: Json | null
          scrape_error?: string | null
          scrape_status?: string
          spa_name?: string | null
          spa_url: string
          updated_at?: string
        }
        Update: {
          claimed_at?: string | null
          claimed_by?: string | null
          created_at?: string
          id?: string
          scrape_data?: Json | null
          scrape_error?: string | null
          scrape_status?: string
          spa_name?: string | null
          spa_url?: string
          updated_at?: string
        }
        Relationships: []
      }
      spa_promo_interest: {
        Row: {
          created_at: string
          id: string
          message: string | null
          promotion_node_id: string
          rep_user_id: string
          spa_user_id: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          message?: string | null
          promotion_node_id: string
          rep_user_id: string
          spa_user_id: string
          status: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          message?: string | null
          promotion_node_id?: string
          rep_user_id?: string
          spa_user_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "spa_promo_interest_promotion_node_id_fkey"
            columns: ["promotion_node_id"]
            isOneToOne: false
            referencedRelation: "knowledge_nodes"
            referencedColumns: ["id"]
          },
        ]
      }
      spa_rep_data_share: {
        Row: {
          created_at: string
          granted_at: string
          id: string
          rep_user_id: string
          revoked_at: string | null
          share_level: string
          spa_note: string | null
          spa_user_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          granted_at?: string
          id?: string
          rep_user_id: string
          revoked_at?: string | null
          share_level?: string
          spa_note?: string | null
          spa_user_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          granted_at?: string
          id?: string
          rep_user_id?: string
          revoked_at?: string | null
          share_level?: string
          spa_note?: string | null
          spa_user_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      stripe_webhook_events: {
        Row: {
          created_at: string
          error_message: string | null
          event_type: string
          id: string
          payload: Json | null
          processed_at: string | null
          product: string | null
          received_at: string
          status: string
          stripe_event_id: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          event_type: string
          id?: string
          payload?: Json | null
          processed_at?: string | null
          product?: string | null
          received_at?: string
          status?: string
          stripe_event_id: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          event_type?: string
          id?: string
          payload?: Json | null
          processed_at?: string | null
          product?: string | null
          received_at?: string
          status?: string
          stripe_event_id?: string
        }
        Relationships: []
      }
      suppressed_emails: {
        Row: {
          created_at: string
          email: string
          id: string
          metadata: Json | null
          reason: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          metadata?: Json | null
          reason: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          metadata?: Json | null
          reason?: string
        }
        Relationships: []
      }
      tenant_engagement_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          payload: Json
          response_received_at: string | null
          response_text: string | null
          sent_at: string | null
          source_drip_id: string | null
          tenant_id: string
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          payload?: Json
          response_received_at?: string | null
          response_text?: string | null
          sent_at?: string | null
          source_drip_id?: string | null
          tenant_id: string
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          payload?: Json
          response_received_at?: string | null
          response_text?: string | null
          sent_at?: string | null
          source_drip_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_engagement_events_source_drip_id_fkey"
            columns: ["source_drip_id"]
            isOneToOne: false
            referencedRelation: "tenant_engagement_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_engagement_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_memberships: {
        Row: {
          created_at: string
          id: string
          role: string
          tenant_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role?: string
          tenant_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: string
          tenant_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_memberships_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          created_at: string
          delivery_channel: string
          id: string
          is_demo: boolean
          name: string
          payment_method_added_at: string | null
          plan: string
          referred_by_rep_id: string | null
          slug: string
          stripe_customer_id: string | null
          stripe_customer_id_live: string | null
          stripe_customer_id_test: string | null
          trial_ends_at: string
          trial_starts_at: string
        }
        Insert: {
          created_at?: string
          delivery_channel?: string
          id?: string
          is_demo?: boolean
          name: string
          payment_method_added_at?: string | null
          plan?: string
          referred_by_rep_id?: string | null
          slug: string
          stripe_customer_id?: string | null
          stripe_customer_id_live?: string | null
          stripe_customer_id_test?: string | null
          trial_ends_at?: string
          trial_starts_at?: string
        }
        Update: {
          created_at?: string
          delivery_channel?: string
          id?: string
          is_demo?: boolean
          name?: string
          payment_method_added_at?: string | null
          plan?: string
          referred_by_rep_id?: string | null
          slug?: string
          stripe_customer_id?: string | null
          stripe_customer_id_live?: string | null
          stripe_customer_id_test?: string | null
          trial_ends_at?: string
          trial_starts_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenants_referred_by_rep_id_fkey"
            columns: ["referred_by_rep_id"]
            isOneToOne: false
            referencedRelation: "rep_accounts"
            referencedColumns: ["rep_user_id"]
          },
        ]
      }
      user_preferences: {
        Row: {
          created_at: string
          prefs: Json
          primary_role: string | null
          rep_tier_policy: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          prefs?: Json
          primary_role?: string | null
          rep_tier_policy?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          prefs?: Json
          primary_role?: string | null
          rep_tier_policy?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      wishlist_requests: {
        Row: {
          admin_notes: string | null
          area: string | null
          created_at: string
          declined_at: string | null
          description: string
          id: string
          in_progress_at: string | null
          messages: Json
          priority: Database["public"]["Enums"]["wishlist_priority"]
          reviewing_at: string | null
          shipped_at: string | null
          shipped_in_version: string | null
          status: Database["public"]["Enums"]["wishlist_status"]
          tenant_id: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          admin_notes?: string | null
          area?: string | null
          created_at?: string
          declined_at?: string | null
          description: string
          id?: string
          in_progress_at?: string | null
          messages?: Json
          priority?: Database["public"]["Enums"]["wishlist_priority"]
          reviewing_at?: string | null
          shipped_at?: string | null
          shipped_in_version?: string | null
          status?: Database["public"]["Enums"]["wishlist_status"]
          tenant_id: string
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          admin_notes?: string | null
          area?: string | null
          created_at?: string
          declined_at?: string | null
          description?: string
          id?: string
          in_progress_at?: string | null
          messages?: Json
          priority?: Database["public"]["Enums"]["wishlist_priority"]
          reviewing_at?: string | null
          shipped_at?: string | null
          shipped_in_version?: string | null
          status?: Database["public"]["Enums"]["wishlist_status"]
          tenant_id?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wishlist_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      delete_email: {
        Args: { message_id: number; queue_name: string }
        Returns: boolean
      }
      enqueue_email: {
        Args: { payload: Json; queue_name: string }
        Returns: number
      }
      get_rep_network: {
        Args: { max_depth?: number; root_rep_id: string }
        Returns: {
          business_name: string
          depth: number
          display_name: string
          joined_at: string
          parent_rep_id: string
          rep_id: string
          status: string
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      move_to_dlq: {
        Args: {
          dlq_name: string
          message_id: number
          payload: Json
          source_queue: string
        }
        Returns: number
      }
      read_email_batch: {
        Args: { batch_size: number; queue_name: string; vt: number }
        Returns: {
          message: Json
          msg_id: number
          read_ct: number
        }[]
      }
      refill_bulk_set_vip: {
        Args: { p_add_ids: string[]; p_remove_ids: string[]; p_user_id: string }
        Returns: number
      }
      refill_recompute_reliability_counts: {
        Args: { p_user_id: string }
        Returns: number
      }
      wipe_karen_demo_data: {
        Args: never
        Returns: {
          deleted_table: string
          row_count: number
        }[]
      }
      wipe_kelly_demo_data: {
        Args: never
        Returns: {
          deleted_table: string
          row_count: number
        }[]
      }
    }
    Enums: {
      app_role:
        | "admin"
        | "member"
        | "spa_owner"
        | "rep"
        | "sub_rep"
        | "developer"
      wishlist_priority: "low" | "normal" | "high" | "urgent"
      wishlist_status:
        | "submitted"
        | "reviewing"
        | "in_progress"
        | "shipped"
        | "declined"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "member", "spa_owner", "rep", "sub_rep", "developer"],
      wishlist_priority: ["low", "normal", "high", "urgent"],
      wishlist_status: [
        "submitted",
        "reviewing",
        "in_progress",
        "shipped",
        "declined",
      ],
    },
  },
} as const
