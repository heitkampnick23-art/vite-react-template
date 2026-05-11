import { create } from "zustand";
import type { UserPublic } from "../../shared/types";

type AuthState = {
	user: UserPublic | null;
	loading: boolean;
	setUser: (u: UserPublic | null) => void;
	setLoading: (b: boolean) => void;
};

export const useAuth = create<AuthState>((set) => ({
	user: null,
	loading: true,
	setUser: (user) => set({ user, loading: false }),
	setLoading: (loading) => set({ loading }),
}));
