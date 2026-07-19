import { createSlice, PayloadAction } from "@reduxjs/toolkit";
import { ComposeRepositoryResponse } from "@/types/domain";

interface RepositoryState {
    data?: ComposeRepositoryResponse;
    loading: boolean;
    error: string;
}

const initialState : RepositoryState = {
    loading: false,
    error: "",
};

const repositorySlice = createSlice({
    name: "repository",
    initialState,
    reducers: {
        repositoryLoading(state) {
            state.loading = true;
            state.error = "";
        },
        repositoryReceived(state, action : PayloadAction<ComposeRepositoryResponse>) {
            state.data = action.payload;
            state.loading = false;
        },
        repositoryFailed(state, action : PayloadAction<string>) {
            state.loading = false;
            state.error = action.payload;
        },
    },
});

export const { repositoryFailed, repositoryLoading, repositoryReceived } = repositorySlice.actions;
export default repositorySlice.reducer;
