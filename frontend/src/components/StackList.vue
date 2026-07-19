<template>
    <div class="shadow-box mb-3" :style="boxStyle">
        <div class="list-header">
            <div class="header-top">
                <!-- TODO -->
                <button
                    v-if="false" class="btn btn-outline-normal ms-2" :class="{ 'active': selectMode }" type="button"
                    @click="selectMode = !selectMode"
                >
                    {{ $t("Select") }}
                </button>

                <div class="list-title">
                    <span>Stacks</span>
                    <strong>{{ totalStackCount }}</strong>
                </div>
                <div class="search-wrapper">
                    <a v-if="searchText == ''" class="search-icon">
                        <font-awesome-icon icon="search" />
                    </a>
                    <a v-if="searchText != ''" class="search-icon" style="cursor: pointer" @click="clearSearchText">
                        <font-awesome-icon icon="times" />
                    </a>
                    <form>
                        <input v-model="searchText" class="form-control search-input" autocomplete="off" placeholder="Search" />
                    </form>
                </div>
            </div>

            <!-- TODO -->
            <div v-if="false" class="header-filter">
                <!--<StackListFilter :filterState="filterState" @update-filter="updateFilter" />-->
            </div>

            <!-- TODO: Selection Controls -->
            <div v-if="selectMode && false" class="selection-controls px-2 pt-2">
                <input v-model="selectAll" class="form-check-input select-input" type="checkbox" />

                <button class="btn-outline-normal" @click="pauseDialog">
                    <font-awesome-icon icon="pause" size="sm" /> {{
                        $t("Pause") }}
                </button>
                <button class="btn-outline-normal" @click="resumeSelected">
                    <font-awesome-icon icon="play" size="sm" />
                    {{ $t("Resume") }}
                </button>

                <span v-if="selectedStackCount > 0">
                    {{ $t("selectedStackCount", [selectedStackCount]) }}
                </span>
            </div>
        </div>
        <div ref="stackList" class="stack-list" :class="{ scrollbar: scrollbar }" :style="stackListStyle">
            <div v-if="agentStackList[0] && agentStackList[0].stacks.length === 0" class="text-center mt-3">
                <router-link to="/compose">{{ $t("addFirstStackMsg") }}</router-link>
            </div>
            <div v-for="(agent, agentIndex) in agentStackList" :key="agentIndex" class="stack-list-inner">
                <div
                    v-if="$root.agentCount > 1" class="p-2 agent-select"
                    @click="closedAgents.set(agent.endpoint, !closedAgents.get(agent.endpoint))"
                >
                    <span class="me-1">
                        <font-awesome-icon v-show="closedAgents.get(agent.endpoint)" icon="chevron-circle-right" />
                        <font-awesome-icon v-show="!closedAgents.get(agent.endpoint)" icon="chevron-circle-down" />
                    </span>
                    <span v-if="agent.endpoint === 'current'">{{ $t("currentEndpoint") }}</span>
                    <span v-else>{{ agent.endpoint }}</span>
                </div>
                <StackListItem
                    v-for="(item, index) in agent.stacks"
                    v-show="$root.agentCount === 1 || !closedAgents.get(agent.endpoint)" :key="index" :stack="item" :isSelectMode="selectMode"
                    :isSelected="isSelected" :select="select" :deselect="deselect"
                />
            </div>
        </div>
    </div>

    <Confirm ref="confirmPause" :yes-text="$t('Yes')" :no-text="$t('No')" @yes="pauseSelected">
        {{ $t("pauseStackMsg") }}
    </Confirm>
</template>

<script>
import Confirm from "../components/Confirm.vue";
import StackListItem from "../components/StackListItem.vue";
import { CREATED_FILE, CREATED_STACK, EXITED, RUNNING, UNKNOWN } from "../../../common/util-common";

export default {
    components: {
        Confirm,
        StackListItem,
    },
    props: {
        /** Should the scrollbar be shown */
        scrollbar: {
            type: Boolean,
        },
    },
    data() {
        return {
            searchText: "",
            selectMode: false,
            selectAll: false,
            disableSelectAllWatcher: false,
            selectedStacks: {},
            windowTop: 0,
            filterState: {
                status: null,
                active: null,
                tags: null,
            },
            closedAgents: new Map(),
        };
    },
    computed: {
        /**
         * Improve the sticky appearance of the list by increasing its
         * height as user scrolls down.
         * Not used on mobile.
         * @returns {object} Style for stack list
         */
        boxStyle() {
            if (window.innerWidth > 550) {
                return {
                    height: `calc(100vh - 160px + ${this.windowTop}px)`,
                };
            } else {
                return {
                    height: "calc(100vh - 160px)",
                };
            }

        },

        /**
         * Returns a sorted list of stacks based on the applied filters and search text.
         * @returns {Array} The sorted list of stacks.
         */
        agentStackList() {
            let result = Object.values(this.$root.completeStackList);

            result = result.filter(stack => {
                // filter by search text
                // finds stack name, tag name or tag value
                let searchTextMatch = true;
                if (this.searchText !== "") {
                    const loweredSearchText = this.searchText.toLowerCase();
                    searchTextMatch =
                        stack.name.toLowerCase().includes(loweredSearchText)
                        || stack.tags.find(tag => tag.name.toLowerCase().includes(loweredSearchText)
                            || tag.value?.toLowerCase().includes(loweredSearchText));
                }

                // filter by active
                let activeMatch = true;
                if (this.filterState.active != null && this.filterState.active.length > 0) {
                    activeMatch = this.filterState.active.includes(stack.active);
                }

                // filter by tags
                let tagsMatch = true;
                if (this.filterState.tags != null && this.filterState.tags.length > 0) {
                    tagsMatch = stack.tags.map(tag => tag.tag_id) // convert to array of tag IDs
                        .filter(stackTagId => this.filterState.tags.includes(stackTagId)) // perform Array Intersaction between filter and stack's tags
                        .length > 0;
                }

                return searchTextMatch && activeMatch && tagsMatch;
            });

            result.sort((m1, m2) => {

                // sort by managed by dockge
                if (m1.isManagedByDockge && !m2.isManagedByDockge) {
                    return -1;
                } else if (!m1.isManagedByDockge && m2.isManagedByDockge) {
                    return 1;
                }

                // sort by status
                if (m1.status !== m2.status) {
                    if (m2.status === RUNNING) {
                        return 1;
                    } else if (m1.status === RUNNING) {
                        return -1;
                    } else if (m2.status === EXITED) {
                        return 1;
                    } else if (m1.status === EXITED) {
                        return -1;
                    } else if (m2.status === CREATED_STACK) {
                        return 1;
                    } else if (m1.status === CREATED_STACK) {
                        return -1;
                    } else if (m2.status === CREATED_FILE) {
                        return 1;
                    } else if (m1.status === CREATED_FILE) {
                        return -1;
                    } else if (m2.status === UNKNOWN) {
                        return 1;
                    } else if (m1.status === UNKNOWN) {
                        return -1;
                    }
                }
                return m1.name.localeCompare(m2.name);
            });

            // Group stacks by endpoint, sorting them so the local endpoint is first
            // and the rest are sorted alphabetically
            result = [
                ...result.reduce((acc, stack) => {
                    const endpoint = stack.endpoint || "current";
                    if (!acc.has(endpoint)) {
                        acc.set(endpoint, []);
                    }
                    acc.get(endpoint).push(stack);
                    return acc;
                }, new Map()).entries()
            ].map(([ endpoint, stacks ]) => ({
                endpoint,
                stacks
            })).sort((a, b) => {
                if (a.endpoint === "current" && b.endpoint !== "current") {
                    return -1;
                } else if (a.endpoint !== "current" && b.endpoint === "current") {
                    return 1;
                }
                return a.endpoint.localeCompare(b.endpoint);
            });

            return result;
        },

        isDarkTheme() {
            return document.body.classList.contains("dark");
        },

        totalStackCount() {
            return Object.values(this.$root.completeStackList).length;
        },

        stackListStyle() {
            //let listHeaderHeight = 107;
            let listHeaderHeight = 60;

            if (this.selectMode) {
                listHeaderHeight += 42;
            }

            return {
                "height": `calc(100% - ${listHeaderHeight}px)`
            };
        },

        selectedStackCount() {
            return Object.keys(this.selectedStacks).length;
        },

        /**
         * Determines if any filters are active.
         * @returns {boolean} True if any filter is active, false otherwise.
         */
        filtersActive() {
            return this.filterState.status != null || this.filterState.active != null || this.filterState.tags != null || this.searchText !== "";
        }
    },
    watch: {
        searchText() {
            for (let stack of this.agentStackList) {
                if (!this.selectedStacks[stack.id]) {
                    if (this.selectAll) {
                        this.disableSelectAllWatcher = true;
                        this.selectAll = false;
                    }
                    break;
                }
            }
        },
        selectAll() {
            if (!this.disableSelectAllWatcher) {
                this.selectedStacks = {};

                if (this.selectAll) {
                    this.agentStackList.forEach((item) => {
                        this.selectedStacks[item.id] = true;
                    });
                }
            } else {
                this.disableSelectAllWatcher = false;
            }
        },
        selectMode() {
            if (!this.selectMode) {
                this.selectAll = false;
                this.selectedStacks = {};
            }
        },
    },
    mounted() {
        window.addEventListener("scroll", this.onScroll);
    },
    beforeUnmount() {
        window.removeEventListener("scroll", this.onScroll);
    },
    methods: {
        /**
         * Handle user scroll
         * @returns {void}
         */
        onScroll() {
            if (window.top.scrollY <= 133) {
                this.windowTop = window.top.scrollY;
            } else {
                this.windowTop = 133;
            }
        },

        /**
         * Clear the search bar
         * @returns {void}
         */
        clearSearchText() {
            this.searchText = "";
        },
        /**
         * Update the StackList Filter
         * @param {object} newFilter Object with new filter
         * @returns {void}
         */
        updateFilter(newFilter) {
            this.filterState = newFilter;
        },
        /**
         * Deselect a stack
         * @param {number} id ID of stack
         * @returns {void}
         */
        deselect(id) {
            delete this.selectedStacks[id];
        },
        /**
         * Select a stack
         * @param {number} id ID of stack
         * @returns {void}
         */
        select(id) {
            this.selectedStacks[id] = true;
        },
        /**
         * Determine if stack is selected
         * @param {number} id ID of stack
         * @returns {bool} Is the stack selected?
         */
        isSelected(id) {
            return id in this.selectedStacks;
        },
        /**
         * Disable select mode and reset selection
         * @returns {void}
         */
        cancelSelectMode() {
            this.selectMode = false;
            this.selectedStacks = {};
        },
        /**
         * Show dialog to confirm pause
         * @returns {void}
         */
        pauseDialog() {
            this.$refs.confirmPause.show();
        },
        /**
         * Pause each selected stack
         * @returns {void}
         */
        pauseSelected() {
            Object.keys(this.selectedStacks)
                .filter(id => this.$root.stackList[id].active)
                .forEach(id => this.$root.getSocket().emit("pauseStack", id, () => { }));

            this.cancelSelectMode();
        },
        /**
         * Resume each selected stack
         * @returns {void}
         */
        resumeSelected() {
            Object.keys(this.selectedStacks)
                .filter(id => !this.$root.stackList[id].active)
                .forEach(id => this.$root.getSocket().emit("resumeStack", id, () => { }));

            this.cancelSelectMode();
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../styles/vars.scss";

.shadow-box {
    height: calc(100vh - 156px);
    position: sticky;
    top: 86px;
    padding: 0;
    overflow: hidden;
}

.small-padding {
    padding-left: 5px !important;
    padding-right: 5px !important;
}

.list-header {
    border-bottom: 1px solid $border-color;
    margin: 0;
    padding: 12px;
    background: rgba(255, 255, 255, 0.86);

    .dark & {
        background-color: $dark-header-bg;
        border-bottom: 1px solid $dark-border-color;
    }
}

.header-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
}

.list-title {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    color: $muted-color;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;

    strong {
        min-width: 26px;
        padding: 2px 7px;
        border-radius: 999px;
        background: $surface-subtle;
        color: $text-color;
        text-align: center;
        letter-spacing: 0;
    }

    .dark & {
        color: $dark-font-color3;

        strong {
            background: $dark-bg;
            color: $dark-font-color;
        }
    }
}

.header-filter {
    display: flex;
    align-items: center;
}

@media (max-width: 770px) {
    .list-header {
        margin: 0;
        margin-bottom: 10px;
        padding: 10px;
    }

    .header-top {
        flex-wrap: wrap;
    }

    .search-wrapper {
        flex-basis: 100%;
    }

    .search-input {
        max-width: none;
        width: 100%;
    }
}

.search-wrapper {
    display: flex;
    align-items: center;
    min-width: 0;
    flex: 1;
    justify-content: flex-end;
}

.search-icon {
    padding: 8px;
    color: $muted-color;

    // Clear filter button (X)
    svg[data-icon="times"] {
        cursor: pointer;
        transition: all ease-in-out 0.1s;

        &:hover {
            opacity: 0.5;
        }
    }
}

.search-input {
    max-width: 168px;
    min-height: 36px;
    border-radius: 8px;
    background: $surface-muted;
    border-color: transparent;
}

.stack-list {
    padding: 8px;
}

.stack-item {
    width: 100%;
}

.tags {
    margin-top: 4px;
    padding-left: 67px;
    display: flex;
    flex-wrap: wrap;
    gap: 0;
}

.bottom-style {
    padding-left: 67px;
    margin-top: 5px;
}

.selection-controls {
    margin-top: 5px;
    display: flex;
    align-items: center;
    gap: 10px;
}

.agent-select {
    cursor: pointer;
    font-size: 14px;
    font-weight: 500;
    color: $muted-color;
    padding-left: 10px;
    padding-right: 10px;
    display: flex;
    align-items: center;
    user-select: none;
    border-radius: 8px;

    &:hover {
        background: $surface-subtle;
    }

    .dark & {
        color: $dark-font-color3;

        &:hover {
            background: $dark-bg;
        }
    }
}
</style>
