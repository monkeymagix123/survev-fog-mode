import type { DeepPartial } from "../../utils/util";
import { util } from "../../utils/util";
import type { MapDef } from "../mapDefs";
import { Main } from "./baseDefs";

const mapDef: DeepPartial<MapDef> = {
    desc: {
        name: "Fog",
        icon: "",
        buttonCss: "",
        buttonText: "fog",
        backgroundImg: "img/main_splash.png",
    },
    biome: {
        colors: {
            background: 0x030303,
        },
    },
};

export const MainFog = util.mergeDeep({}, Main, mapDef) as MapDef;
