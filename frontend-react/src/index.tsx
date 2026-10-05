import React from "react";
import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
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
        <Provider store={store}>
            <BrowserRouter>
                <App />
            </BrowserRouter>
        </Provider>
    </React.StrictMode>
);
