import toChildrenArray from 'rc-util/lib/Children/toArray';
import warning from 'rc-util/lib/warning';
import * as React from 'react';
import type {
  FieldEntity,
  FormInstance,
  InternalNamePath,
  Meta,
  NamePath,
  NotifyInfo,
  Rule,
  Store,
  ValidateOptions,
  InternalFormInstance,
  RuleObject,
  StoreValue,
  EventArgs,
  RuleError,
} from './interface';
import FieldContext, { HOOK_MARK } from './FieldContext';
import { toArray } from './utils/typeUtil';
import { validateRules } from './utils/validateUtil';
import {
  containsNamePath,
  defaultGetValueFromEvent,
  getNamePath,
  getValue,
} from './utils/valueUtil';

const EMPTY_ERRORS: any[] = [];

export type ShouldUpdate<Values = any> =
  | boolean
  | ((prevValues: Values, nextValues: Values, info: { source?: string }) => boolean);

function requireUpdate(
  shouldUpdate: ShouldUpdate,
  prev: StoreValue,
  next: StoreValue,
  prevValue: StoreValue,
  nextValue: StoreValue,
  info: NotifyInfo,
): boolean {
  if (typeof shouldUpdate === 'function') {
    return shouldUpdate(prev, next, 'source' in info ? { source: info.source } : {});
  }
  return prevValue !== nextValue;
}

// eslint-disable-next-line @typescript-eslint/consistent-indexed-object-style
interface ChildProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [name: string]: any;
}

export interface InternalFieldProps<Values = any> {
  children?:
    | React.ReactElement
    | ((control: ChildProps, meta: Meta, form: FormInstance<Values>) => React.ReactNode);
  /**
   * Set up `dependencies` field.
   * When dependencies field update and current field is touched,
   * will trigger validate rules and render.
   */
  dependencies?: NamePath[];
  getValueFromEvent?: (...args: EventArgs) => StoreValue;
  name?: InternalNamePath;
  normalize?: (value: StoreValue, prevValue: StoreValue, allValues: Store) => StoreValue;
  rules?: Rule[];
  shouldUpdate?: ShouldUpdate<Values>;
  trigger?: string;
  validateTrigger?: string | string[] | false;
  validateFirst?: boolean | 'parallel';
  valuePropName?: string;
  getValueProps?: (value: StoreValue) => Record<string, unknown>;
  messageVariables?: Record<string, string>;
  initialValue?: any;
  onReset?: () => void;
  onMetaChange?: (meta: Meta & { destroy?: boolean }) => void;
  preserve?: boolean;

  /** @private Passed by Form.List props. Do not use since it will break by path check. */
  isListField?: boolean;

  /** @private Passed by Form.List props. Do not use since it will break by path check. */
  isList?: boolean;

  /** @private Pass context as prop instead of context api
   *  since class component can not get context in constructor */
  fieldContext?: InternalFormInstance;
}

export interface FieldProps<Values = any>
  extends Omit<InternalFieldProps<Values>, 'name' | 'fieldContext'> {
  name?: NamePath;
}

export interface FieldState {
  resetCount: number;
}

/**
 * 用于获取 Form 的上下文
 */
// We use Class instead of Hooks here since it will cost much code by using Hooks.
class Field extends React.Component<InternalFieldProps, FieldState> implements FieldEntity {
  public static contextType = FieldContext;

  public static defaultProps = {
    trigger: 'onChange',
    valuePropName: 'value',
  };
  // 内部的 state 是没有 value 的，通过 FormStore 改变值后发送通知，最终在 Field 中强制渲染更新
  public state = {
    resetCount: 0,
  };

  private cancelRegisterFunc: (
    isListField?: boolean,
    preserve?: boolean,
    namePath?: InternalNamePath,
  ) => void | null = null;

  private mounted = false;

  /**
   * Follow state should not management in State since it will async update by React.
   * This makes first render of form can not get correct state value.
   */
  private touched: boolean = false;

  /**
   * Mark when touched & validated. Currently only used for `dependencies`.
   * Note that we do not think field with `initialValue` is dirty
   * isFieldDirty function 会认为是脏的字段，但是本身对 Field 组件来说不代表脏状态
   * but this will be by `isFieldDirty` func.
   */
  private dirty: boolean = false;

  private validatePromise: Promise<string[]> | null = null;

  private prevValidating: boolean;

  private errors: string[] = EMPTY_ERRORS;
  private warnings: string[] = EMPTY_ERRORS;

  // ============================== Subscriptions ==============================
  // constructor 内更新初始值
  constructor(props: InternalFieldProps) {
    super(props);
    // Register on init 如果 Field 在 Form 内部
    if (props.fieldContext) {
      const { getInternalHooks }: InternalFormInstance = props.fieldContext;
      const { initEntityValue } = getInternalHooks(HOOK_MARK);
      initEntityValue(this);
    }
  }

  public componentDidMount() {
    const { shouldUpdate, fieldContext } = this.props;

    this.mounted = true;

    // Register on init
    if (fieldContext) {
      const { getInternalHooks }: InternalFormInstance = fieldContext;
      const { registerField } = getInternalHooks(HOOK_MARK);
      this.cancelRegisterFunc = registerField(this);
    }
    // 如果 shouldUpdate（可以为一个比较函数） 直接为 true 则马上重新渲染
    // One more render for component in case fields not ready
    if (shouldUpdate === true) {
      this.reRender();
    }
  }

  public componentWillUnmount() {
    this.cancelRegister();
    this.triggerMetaEvent(true);
    this.mounted = false;
  }

  public cancelRegister = () => {
    const { preserve, isListField, name } = this.props;

    if (this.cancelRegisterFunc) {
      this.cancelRegisterFunc(isListField, preserve, getNamePath(name));
    }
    this.cancelRegisterFunc = null;
  };

  // ================================== Utils ==================================
  /**
   * 这里主要是给 formInstance 使用的
   * @returns
   */
  public getNamePath = (): InternalNamePath => {
    const { name, fieldContext } = this.props;
    const { prefixName = [] }: InternalFormInstance = fieldContext;

    return name !== undefined ? [...prefixName, ...name] : [];
  };

  public getRules = (): RuleObject[] => {
    const { rules = [], fieldContext } = this.props;

    return rules.map((rule: Rule): RuleObject => {
      if (typeof rule === 'function') {
        return rule(fieldContext);
      }
      return rule;
    });
  };

  public reRender() {
    if (!this.mounted) return;
    this.forceUpdate();
  }

  /**
   * 刷新会改变 Field 渲染的 key，强制更新节点
   * @returns
   */
  public refresh = () => {
    if (!this.mounted) return;

    /**
     * Clean up current node.
     */
    this.setState(({ resetCount }) => ({
      resetCount: resetCount + 1,
    }));
  };
  /**
   * 往外传相关 meta 更新信息
   * @param destroy
   */
  public triggerMetaEvent = (destroy?: boolean) => {
    const { onMetaChange } = this.props;
    // Filed 相关 meta 信息修改
    onMetaChange?.({ ...this.getMeta(), destroy });
  };

  // ========================= Field Entity Interfaces =========================
  // Trigger by store update. Check if need update the component
  /**
   * Form Store 发放通知
   * @param prevStore
   * @param namePathList
   * @param info
   * @returns
   */
  public onStoreChange: FieldEntity['onStoreChange'] = (prevStore, namePathList, info) => {
    const { shouldUpdate, dependencies = [], onReset } = this.props;
    const { store } = info;
    const namePath = this.getNamePath();
    const prevValue = this.getValue(prevStore);
    const curValue = this.getValue(store);
    // 修改的值是否和当前的 namePath 匹配
    const namePathMatch = namePathList && containsNamePath(namePathList, namePath);

    // 如果是修改所有值（setFieldsValue）才会触发下面
    // `setFieldsValue` is a quick access to update related status
    if (info.type === 'valueUpdate' && info.source === 'external' && prevValue !== curValue) {
      // 重置所有状态
      this.touched = true;
      this.dirty = true;
      this.validatePromise = null;
      this.errors = EMPTY_ERRORS;
      this.warnings = EMPTY_ERRORS;
      this.triggerMetaEvent();
    }

    switch (info.type) {
      case 'reset':
        if (!namePathList || namePathMatch) {
          // Clean up state
          this.touched = false;
          this.dirty = false;
          this.validatePromise = null;
          this.errors = EMPTY_ERRORS;
          this.warnings = EMPTY_ERRORS;
          this.triggerMetaEvent();

          onReset?.();

          this.refresh();
          return;
        }
        break;

      /**
       * In case field with `preserve = false` nest deps like:
       * - A = 1 => show B
       * - B = 1 => show C
       * - Reset A, need clean B, C
       */
      case 'remove': {
        // 有 shouldUpdate 就更新
        if (shouldUpdate) {
          this.reRender();
          return;
        }
        break;
      }

      case 'setField': {
        if (namePathMatch) {
          const { data } = info;

          if ('touched' in data) {
            this.touched = data.touched;
          }
          if ('validating' in data && !('originRCField' in data)) {
            this.validatePromise = data.validating ? Promise.resolve([]) : null;
          }
          if ('errors' in data) {
            this.errors = data.errors || EMPTY_ERRORS;
          }
          if ('warnings' in data) {
            this.warnings = data.warnings || EMPTY_ERRORS;
          }
          this.dirty = true;

          this.triggerMetaEvent();

          this.reRender();
          return;
        }
        // 如果有 shouldUpdate，setField 时即使没有匹配上也可以 reRender
        // Handle update by `setField` with `shouldUpdate`
        if (
          shouldUpdate &&
          // 没有 name
          !namePath.length &&
          requireUpdate(shouldUpdate, prevStore, store, prevValue, curValue, info)
        ) {
          this.reRender();
          return;
        }
        break;
      }

      // 依赖更新了
      case 'dependenciesUpdate': {
        /**
         * Trigger when marked `dependencies` updated. Related fields will all update
         */
        const dependencyList = dependencies.map(getNamePath);
        // 在这之前触发 valueUpdate 时会检测 namePathMath 与 shouldUpdate，所以不在这里检测
        // No need for `namePathMath` check and `shouldUpdate` check, since `valueUpdate` will be
        // emitted earlier and they will work there
        // If set it may cause unnecessary twice rerendering
        if (dependencyList.some(dependency => containsNamePath(info.relatedFields, dependency))) {
          this.reRender();
          return;
        }
        break;
      }

      // validateFinish 完毕后会到这里，更新 Field 状态（但是其实这里没有必要，在之前获取到 errors 就已经判断过了）,值更新了也会到这里 valueUpdate
      default:
        // 1. If `namePath` exists in `namePathList`, means it's related value and should update
        //      For example <List name="list"><Field name={['list', 0]}></List>
        //      If `namePathList` is [['list']] (List value update), Field should be updated
        //      If `namePathList` is [['list', 0]] (Field value update), List shouldn't be updated
        // 2.
        //   2.1 If `dependencies` is set, `name` is not set and `shouldUpdate` is not set,
        //       don't use `shouldUpdate`. `dependencies` is view as a shortcut if `shouldUpdate`
        //       is not provided
        //   2.2 If `shouldUpdate` provided, use customize logic to update the field
        //       else to check if value changed
        if (
          namePathMatch ||
          ((!dependencies.length || namePath.length || shouldUpdate) &&
            requireUpdate(shouldUpdate, prevStore, store, prevValue, curValue, info))
        ) {
          this.reRender();
          return;
        }
        break;
    }

    if (shouldUpdate === true) {
      this.reRender();
    }
  };

  public validateRules = (options?: ValidateOptions): Promise<RuleError[]> => {
    // We should fixed namePath & value to avoid developer change then by form function
    const namePath = this.getNamePath();
    const currentValue = this.getValue();

    //强制改为异步校验
    // Force change to async to avoid rule OOD under renderProps field
    const rootPromise = Promise.resolve().then(() => {
      if (!this.mounted) {
        return [];
      }

      // messageVariables 为用户传入的验证 Message 变量
      const { validateFirst = false, messageVariables } = this.props;
      const { triggerName } = (options || {}) as ValidateOptions;

      let filteredRules = this.getRules();
      if (triggerName) {
        // 过滤不触发的 rule
        filteredRules = filteredRules.filter((rule: RuleObject) => {
          const { validateTrigger } = rule;
          if (!validateTrigger) {
            return true;
          }
          const triggerList = toArray(validateTrigger);
          return triggerList.includes(triggerName);
        });
      }
      // 验证
      const promise = validateRules(
        namePath,
        currentValue,
        filteredRules,
        options,
        validateFirst,
        messageVariables,
      );

      promise
        .catch(e => e)
        .then((ruleErrors: RuleError[] = EMPTY_ERRORS) => {
          // 只管最后一个进行中的校验
          if (this.validatePromise === rootPromise) {
            this.validatePromise = null;

            // Get errors & warnings
            const nextErrors: string[] = [];
            const nextWarnings: string[] = [];
            ruleErrors.forEach?.(({ rule: { warningOnly }, errors = EMPTY_ERRORS }) => {
              if (warningOnly) {
                nextWarnings.push(...errors);
              } else {
                nextErrors.push(...errors);
              }
            });

            this.errors = nextErrors;
            this.warnings = nextWarnings;
            this.triggerMetaEvent();

            this.reRender();
          }
        });

      return promise;
    });

    // 正在 validating
    this.validatePromise = rootPromise;
    this.dirty = true;
    this.errors = EMPTY_ERRORS;
    this.warnings = EMPTY_ERRORS;
    this.triggerMetaEvent();
    // 新了 meta，这里是为了同步的 renderProps
    // Force trigger re-render since we need sync renderProps with new meta
    this.reRender();

    return rootPromise;
  };

  public isFieldValidating = () => !!this.validatePromise;

  public isFieldTouched = () => this.touched;

  public isFieldDirty = () => {
    // 是否正在运行行为或者本身有 initialValue（不是 Form 上的 initialValues）
    // Touched or validate or has initialValue
    if (this.dirty || this.props.initialValue !== undefined) {
      return true;
    }

    // Form set initialValue
    const { fieldContext } = this.props;
    const { getInitialValue } = fieldContext.getInternalHooks(HOOK_MARK);
    if (getInitialValue(this.getNamePath()) !== undefined) {
      return true;
    }

    return false;
  };

  public getErrors = () => this.errors;

  public getWarnings = () => this.warnings;

  public isListField = () => this.props.isListField;

  public isList = () => this.props.isList;

  public isPreserve = () => this.props.preserve;

  // ============================= Child Component =============================
  /**
   * 当前 Field 包含的元信息
   * @returns
   */
  public getMeta = (): Meta => {
    // Make error & validating in cache to save perf
    // 是否正在验证字段值
    this.prevValidating = this.isFieldValidating();

    const meta: Meta = {
      touched: this.isFieldTouched(),
      validating: this.prevValidating,
      errors: this.errors,
      warnings: this.warnings,
      name: this.getNamePath(),
    };

    return meta;
  };

  /**
   * 只获取第一个唯一的 child
   * @param children
   * @returns
   */
  // Only return validate child node. If invalidate, will do nothing about field.
  public getOnlyChild = (
    children:
      | React.ReactNode
      | ((control: ChildProps, meta: Meta, context: FormInstance) => React.ReactNode),
  ): { child: React.ReactNode | null; isFunction: boolean } => {
    // Support render props
    if (typeof children === 'function') {
      const meta = this.getMeta();

      return {
        ...this.getOnlyChild(children(this.getControlled(), meta, this.props.fieldContext)),
        isFunction: true,
      };
    }

    // Filed element only
    const childList = toChildrenArray(children);
    if (childList.length !== 1 || !React.isValidElement(childList[0])) {
      return { child: childList, isFunction: false };
    }

    return { child: childList[0], isFunction: false };
  };

  // ============================== Field Control ==============================
  // 获取当前的 value 值，从 Form Context 中获取
  public getValue = (store?: Store) => {
    const { getFieldsValue }: FormInstance = this.props.fieldContext;
    // 当前 filed 对应的 name path
    const namePath = this.getNamePath();
    // 获取所有的 value 值
    return getValue(store || getFieldsValue(true), namePath);
  };

  /**
   * 获取控制器，用于回调值加上触发验证器回调
   * @param childProps
   * @returns
   */
  public getControlled = (childProps: ChildProps = {}) => {
    const {
      // 回调触发方法
      trigger,
      validateTrigger,
      getValueFromEvent,
      normalize,
      valuePropName,
      getValueProps,
      fieldContext,
    } = this.props;
    // 验证触发条件
    const mergedValidateTrigger =
      validateTrigger !== undefined ? validateTrigger : fieldContext.validateTrigger;

    const namePath = this.getNamePath();
    const { getInternalHooks, getFieldsValue }: InternalFormInstance = fieldContext;
    const { dispatch } = getInternalHooks(HOOK_MARK);
    // 传入 value
    const value = this.getValue();
    const mergedGetValueProps = getValueProps || ((val: StoreValue) => ({ [valuePropName]: val }));
    // (val) => ({ value: val })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originTriggerFunc: any = childProps[trigger];

    const control = {
      ...childProps,
      // 因为 (val) => ({ value: val })，所以直接把 value 拿到
      ...mergedGetValueProps(value),
    };

    // 劫持 onChange 等对上级返回的回调
    // Add trigger
    control[trigger] = (...args: EventArgs) => {
      // Mark as touched
      this.touched = true;
      this.dirty = true;

      this.triggerMetaEvent();

      let newValue: StoreValue;
      if (getValueFromEvent) {
        newValue = getValueFromEvent(...args);
      } else {
        newValue = defaultGetValueFromEvent(valuePropName, ...args);
      }

      // 格式化值
      if (normalize) {
        newValue = normalize(newValue, value, getFieldsValue(true));
      }

      // 修改值，经过 FormStore 一系列赋值后最终会通知当前 Field 刷新界面
      dispatch({
        type: 'updateValue',
        namePath,
        value: newValue,
      });

      if (originTriggerFunc) {
        originTriggerFunc(...args);
      }
    };

    // Add validateTrigger
    const validateTriggerList: string[] = toArray(mergedValidateTrigger || []);

    // 调用验证触发
    validateTriggerList.forEach((triggerName: string) => {
      // Wrap additional function of component, so that we can get latest value from store
      const originTrigger = control[triggerName];
      control[triggerName] = (...args: EventArgs) => {
        if (originTrigger) {
          originTrigger(...args);
        }

        // Always use latest rules
        const { rules } = this.props;
        if (rules && rules.length) {
          // We dispatch validate to root,
          // since it will update related data with other field with same name
          dispatch({
            type: 'validateField',
            namePath,
            triggerName,
          });
        }
      };
    });

    return control;
  };

  public render() {
    const { resetCount } = this.state;
    const { children } = this.props;

    const { child, isFunction } = this.getOnlyChild(children);

    // Not need to `cloneElement` since user can handle this in render function self
    let returnChildNode: React.ReactNode;
    if (isFunction) {
      returnChildNode = child;
    } else if (React.isValidElement(child)) {
      returnChildNode = React.cloneElement(
        child as React.ReactElement,
        // 代理 props，返回 control，control 会包装 value 与对应 onChange 等
        this.getControlled((child as React.ReactElement).props),
      );
    } else {
      warning(!child, '`children` of Field is not validate ReactElement.');
      returnChildNode = child;
    }

    return <React.Fragment key={resetCount}>{returnChildNode}</React.Fragment>;
  }
}

function WrapperField<Values = any>({ name, ...restProps }: FieldProps<Values>) {
  // 获取 fieldContext
  const fieldContext = React.useContext(FieldContext);

  // 格式化 name path
  const namePath = name !== undefined ? getNamePath(name) : undefined;

  let key: string = 'keep';
  if (!restProps.isListField) {
    key = `_${(namePath || []).join('_')}`;
  }

  // Warning if it's a directly list field.
  // We can still support multiple level field preserve.
  if (
    process.env.NODE_ENV !== 'production' &&
    restProps.preserve === false &&
    restProps.isListField &&
    namePath.length <= 1
  ) {
    warning(false, '`preserve` should not apply on Form.List fields.');
  }

  return <Field key={key} name={namePath} {...restProps} fieldContext={fieldContext} />;
}

export default WrapperField;
