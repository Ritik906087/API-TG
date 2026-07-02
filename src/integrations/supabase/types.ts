export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      conversations: {
        Row: {
          ai_enabled: boolean;
          avatar_url: string | null;
          created_at: string;
          human_replied: boolean;
          id: string;
          last_message_at: string | null;
          last_message_text: string | null;
          owner_user_id: string;
          started: boolean;
          telegram_chat_id: number;
          telegram_first_name: string | null;
          telegram_last_name: string | null;
          telegram_photo_url: string | null;
          telegram_user_id: number | null;
          telegram_username: string | null;
          title: string | null;
          unread_count: number;
          updated_at: string;
        };
        Insert: {
          ai_enabled?: boolean;
          avatar_url?: string | null;
          created_at?: string;
          human_replied?: boolean;
          id?: string;
          last_message_at?: string | null;
          last_message_text?: string | null;
          owner_user_id: string;
          started?: boolean;
          telegram_chat_id: number;
          telegram_first_name?: string | null;
          telegram_last_name?: string | null;
          telegram_photo_url?: string | null;
          telegram_user_id?: number | null;
          telegram_username?: string | null;
          title?: string | null;
          unread_count?: number;
          updated_at?: string;
        };
        Update: {
          ai_enabled?: boolean;
          avatar_url?: string | null;
          created_at?: string;
          human_replied?: boolean;
          id?: string;
          last_message_at?: string | null;
          last_message_text?: string | null;
          owner_user_id?: string;
          started?: boolean;
          telegram_chat_id?: number;
          telegram_first_name?: string | null;
          telegram_last_name?: string | null;
          telegram_photo_url?: string | null;
          telegram_user_id?: number | null;
          telegram_username?: string | null;
          title?: string | null;
          unread_count?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      messages: {
        Row: {
          content: string | null;
          conversation_id: string;
          created_at: string;
          direction: string;
          duration_seconds: number | null;
          file_name: string | null;
          file_size_bytes: number | null;
          id: string;
          is_deleted: boolean;
          is_edited: boolean;
          media_type: string | null;
          media_url: string | null;
          mime_type: string | null;
          owner_user_id: string;
          reply_to_id: string | null;
          seen: boolean;
          telegram_message_id: number | null;
          updated_at: string;
        };
        Insert: {
          content?: string | null;
          conversation_id: string;
          created_at?: string;
          direction: string;
          duration_seconds?: number | null;
          file_name?: string | null;
          file_size_bytes?: number | null;
          id?: string;
          is_deleted?: boolean;
          is_edited?: boolean;
          media_type?: string | null;
          media_url?: string | null;
          mime_type?: string | null;
          owner_user_id: string;
          reply_to_id?: string | null;
          seen?: boolean;
          telegram_message_id?: number | null;
          updated_at?: string;
        };
        Update: {
          content?: string | null;
          conversation_id?: string;
          created_at?: string;
          direction?: string;
          duration_seconds?: number | null;
          file_name?: string | null;
          file_size_bytes?: number | null;
          id?: string;
          is_deleted?: boolean;
          is_edited?: boolean;
          media_type?: string | null;
          media_url?: string | null;
          mime_type?: string | null;
          owner_user_id?: string;
          reply_to_id?: string | null;
          seen?: boolean;
          telegram_message_id?: number | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_reply_to_id_fkey";
            columns: ["reply_to_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: {
          avatar_url: string | null;
          bio: string | null;
          created_at: string;
          display_name: string | null;
          id: string;
          is_online: boolean;
          last_seen: string;
          telegram_chat_id: number | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          avatar_url?: string | null;
          bio?: string | null;
          created_at?: string;
          display_name?: string | null;
          id?: string;
          is_online?: boolean;
          last_seen?: string;
          telegram_chat_id?: number | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          avatar_url?: string | null;
          bio?: string | null;
          created_at?: string;
          display_name?: string | null;
          id?: string;
          is_online?: boolean;
          last_seen?: string;
          telegram_chat_id?: number | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
