import { configureStore } from "@reduxjs/toolkit";
import sessionReducer from "./sessionSlice";
import runtimeReducer from "./runtimeSlice";
import repositoryReducer from "./repositorySlice";

export const store = configureStore({
    reducer: {
        session: sessionReducer,
        runtime: runtimeReducer,
        repository: repositoryReducer,
    },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
