const path = require("path");
const webpack = require("webpack");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const CompressionPlugin = require("compression-webpack-plugin");

module.exports = (_environment, argv) => {
    const production = argv.mode === "production";
    const styleLoader = production ? MiniCssExtractPlugin.loader : "style-loader";

    return {
        mode: production ? "production" : "development",
        entry: path.resolve(__dirname, "src/index.tsx"),
        output: {
            path: path.resolve(__dirname, "../frontend-dist"),
            filename: production ? "assets/[name].[contenthash:8].js" : "assets/[name].js",
            chunkFilename: production ? "assets/[name].[contenthash:8].js" : "assets/[name].js",
            clean: true,
            publicPath: "/",
        },
        devtool: production ? "source-map" : "eval-cheap-module-source-map",
        devServer: {
            historyApiFallback: true,
            host: "0.0.0.0",
            hot: true,
            port: 5000,
            proxy: [
                {
                    context: [ "/socket.io" ],
                    target: "http://127.0.0.1:8612",
                    ws: true,
                },
            ],
        },
        resolve: {
            extensions: [ ".tsx", ".ts", ".jsx", ".js" ],
            alias: {
                "@": path.resolve(__dirname, "src"),
            },
        },
        module: {
            rules: [
                {
                    test: /\.tsx?$/,
                    exclude: /node_modules/,
                    use: {
                        loader: "ts-loader",
                        options: {
                            transpileOnly: true,
                        },
                    },
                },
                {
                    test: /\.module\.css$/,
                    use: [
                        styleLoader,
                        {
                            loader: "css-loader",
                            options: {
                                modules: {
                                    localIdentName: production ? "[hash:base64:6]" : "[name]__[local]__[hash:base64:4]",
                                    namedExport: false,
                                },
                            },
                        },
                        "postcss-loader",
                    ],
                },
                {
                    test: /\.css$/,
                    exclude: /\.module\.css$/,
                    use: [ styleLoader, "css-loader", "postcss-loader" ],
                },
                {
                    test: /\.(png|jpe?g|gif|webp|avif|svg)$/i,
                    type: "asset/resource",
                },
            ],
        },
        plugins: [
            new HtmlWebpackPlugin({
                template: path.resolve(__dirname, "index.html"),
            }),
            new CopyWebpackPlugin({
                patterns: [
                    {
                        from: path.resolve(__dirname, "../frontend/public"),
                        to: path.resolve(__dirname, "../frontend-dist"),
                    },
                    {
                        from: path.resolve(__dirname, "public"),
                        to: path.resolve(__dirname, "../frontend-dist"),
                        noErrorOnMissing: true,
                    },
                ],
            }),
            new webpack.DefinePlugin({
                FRONTEND_VERSION: JSON.stringify(process.env.npm_package_version || "development"),
                "process.env.FIREBASE_API_KEY": JSON.stringify(process.env.FIREBASE_API_KEY || ""),
                "process.env.FIREBASE_PROJECT_ID": JSON.stringify(process.env.FIREBASE_PROJECT_ID || ""),
                "process.env.FIREBASE_MESSAGING_SENDER_ID": JSON.stringify(process.env.FIREBASE_MESSAGING_SENDER_ID || ""),
                "process.env.FIREBASE_APP_ID": JSON.stringify(process.env.FIREBASE_APP_ID || ""),
            }),
            ...(production ? [
                new MiniCssExtractPlugin({
                    filename: "assets/[name].[contenthash:8].css",
                }),
                new CompressionPlugin({
                    algorithm: "gzip",
                    test: /\.(js|css|html|svg|json)$/i,
                }),
                new CompressionPlugin({
                    algorithm: "brotliCompress",
                    filename: "[path][base].br",
                    test: /\.(js|css|html|svg|json)$/i,
                }),
            ] : []),
        ],
        optimization: {
            runtimeChunk: "single",
            splitChunks: {
                chunks: "all",
            },
        },
    };
};
