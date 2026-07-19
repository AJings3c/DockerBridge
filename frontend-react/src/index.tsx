import React from "react";
import { createRoot } from "react-dom/client";
import { ApolloProvider } from "@apollo/client/react";
import { Provider } from "react-redux";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { graph } from "./services/platform";
import { initializeSession } from "./services/session";
import { store } from "./store/store";
import "./styles/global.css";

initializeSession();

if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
    window.addEventListener("load", () => {
        void navigator.serviceWorker.register("/sw.js");
    });
}

const root = document.getElementById("root");
if (!root) {
    throw new Error("Missing React root element");
}

createRoot(root).render(
    <React.StrictMode>
        <ApolloProvider client={graph}>
            <Provider store={store}>
                <BrowserRouter>
                    <App />
                </BrowserRouter>
            </Provider>
        </ApolloProvider>
    </React.StrictMode>
);
