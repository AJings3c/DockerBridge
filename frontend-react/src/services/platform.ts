import { ApolloClient, HttpLink, InMemoryCache } from "@apollo/client";
import axios from "axios";

export const http = axios.create({
    baseURL: "/api",
    timeout: 15000,
});

export const graph = new ApolloClient({
    cache: new InMemoryCache(),
    link: new HttpLink({ uri: "/graphql" }),
    defaultOptions: {
        query: { fetchPolicy: "cache-first" },
        watchQuery: { fetchPolicy: "cache-first" },
    },
});

export async function initializeFirebase() {
    const apiKey = process.env.FIREBASE_API_KEY;
    const projectId = process.env.FIREBASE_PROJECT_ID;
    if (!apiKey || !projectId) {
        return null;
    }
    const { initializeApp } = await import("firebase/app");
    return initializeApp({
        apiKey,
        projectId,
        messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
        appId: process.env.FIREBASE_APP_ID,
    });
}

interface ProductInfrastructure {
    capture(event : string, properties?: Record<string, unknown>): void;
    report(error : unknown, context?: Record<string, unknown>): void;
    enabled(flag : string): boolean;
}

export const productInfrastructure : ProductInfrastructure = {
    capture() {},
    report(error) {
        if (process.env.NODE_ENV !== "production") {
            console.error(error);
        }
    },
    enabled() {
        return false;
    },
};
