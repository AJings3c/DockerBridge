declare const FRONTEND_VERSION : string;

declare module "*.module.css" {
    const classes : Record<string, string>;
    export default classes;
}
