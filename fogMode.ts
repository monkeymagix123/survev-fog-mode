
/**
 * Visibility rules that the server enforces for every client.
 */
type a = {
    visibility: {
        /**
         * When enabled, clients stop receiving objects that are behind opaque map obstacles.
         *
         * Transparent blockers such as windows and glass walls are ignored so players can still see through them.
         */
        hideObjectsBehindOpaqueObstacles: boolean;
        /**
         * Darkness-mode settings used by fog maps such as "main_fog".
         */
        fogMode: {
            /**
             * Base darkness applied everywhere before the player's light cuts through it.
             * 1 is fully dark, 0 disables the darkness overlay.
             */
            ambientDarkness: number;
            /**
             * How strong the player's light is at the source.
             * Higher values let the light punch farther through darkness.
             */
            lightStrength: number;
            /**
             * Controls how quickly light decays after the no-falloff radius.
             * Higher values make the edge of the light die out faster.
             */
            lightFalloff: number;
            /**
             * World-space radius around the player before light begins to fade.
             */
            lightFalloffStart: number;
            /**
             * If enabled, fog maps also apply obstacle/building shadowing by default.
             */
            enableShadows: boolean;
        };
    };
}


const fogConfig = {
    visibility: {
        hideObjectsBehindOpaqueObstacles: true,
        shadowOverlayAlpha: 0.8,
        fogMode: {
            minBrightness: 0.1,
            maxBrightness: 0.9,
            lightStrength: 1.5,
            lightFalloff: 2,
            lightFalloffStart: 4,
            enableShadows: true,
        },
    },
}