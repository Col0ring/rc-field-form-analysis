import warning from 'rc-util/lib/warning';
import * as React from 'react';
import { HOOK_MARK } from './FieldContext';
import type {
  Callbacks,
  FieldData,
  FieldEntity,
  FieldError,
  FormInstance,
  InternalFieldData,
  InternalFormInstance,
  InternalHooks,
  InternalNamePath,
  InternalValidateFields,
  Meta,
  NamePath,
  NotifyInfo,
  RuleError,
  Store,
  StoreValue,
  ValidateErrorEntity,
  ValidateMessages,
  ValidateOptions,
  ValuedNotifyInfo,
  WatchCallBack,
} from './interface';
import { allPromiseFinish } from './utils/asyncUtil';
import cloneDeep from './utils/cloneDeep';
import { defaultValidateMessages } from './utils/messages';
import NameMap from './utils/NameMap';
import {
  cloneByNamePathList,
  containsNamePath,
  getNamePath,
  getValue,
  matchNamePath,
  setValue,
  setValues,
} from './utils/valueUtil';

type InvalidateFieldEntity = { INVALIDATE_NAME_PATH: InternalNamePath };

interface UpdateAction {
  type: 'updateValue';
  namePath: InternalNamePath;
  value: StoreValue;
}

interface ValidateAction {
  type: 'validateField';
  namePath: InternalNamePath;
  triggerName: string;
}

export type ReducerAction = UpdateAction | ValidateAction;

/**
 * Form
 */
export class FormStore {
  /**
   *
   *  是否将 formInstance 绑定
   * @private
   * @type {boolean}
   * @memberof FormStore
   */
  private formHooked: boolean = false;

  private forceRootUpdate: () => void;

  private subscribable: boolean = true;

  private store: Store = {};

  private fieldEntities: FieldEntity[] = [];

  private initialValues: Store = {};

  private callbacks: Callbacks = {};

  private validateMessages: ValidateMessages = null;

  private preserve?: boolean = null;

  private lastValidatePromise: Promise<FieldError[]> = null;

  constructor(forceRootUpdate: () => void) {
    this.forceRootUpdate = forceRootUpdate;
  }

  /**
   * 生成 form 实例
   * @returns
   */
  public getForm = (): InternalFormInstance => ({
    getFieldValue: this.getFieldValue,
    getFieldsValue: this.getFieldsValue,
    getFieldError: this.getFieldError,
    getFieldWarning: this.getFieldWarning,
    getFieldsError: this.getFieldsError,
    isFieldsTouched: this.isFieldsTouched,
    isFieldTouched: this.isFieldTouched,
    isFieldValidating: this.isFieldValidating,
    isFieldsValidating: this.isFieldsValidating,
    resetFields: this.resetFields,
    setFields: this.setFields,
    setFieldValue: this.setFieldValue,
    setFieldsValue: this.setFieldsValue,
    validateFields: this.validateFields,
    submit: this.submit,
    _init: true,

    getInternalHooks: this.getInternalHooks,
  });

  // ======================== Internal Hooks ========================
  /**
   * 只允许内部使用
   * @param key
   * @returns
   */
  private getInternalHooks = (key: string): InternalHooks | null => {
    if (key === HOOK_MARK) {
      this.formHooked = true;

      return {
        dispatch: this.dispatch,
        initEntityValue: this.initEntityValue,
        registerField: this.registerField,
        useSubscribe: this.useSubscribe,
        setInitialValues: this.setInitialValues,
        destroyForm: this.destroyForm,
        setCallbacks: this.setCallbacks,
        setValidateMessages: this.setValidateMessages,
        getFields: this.getFields,
        setPreserve: this.setPreserve,
        getInitialValue: this.getInitialValue,
        registerWatch: this.registerWatch,
      };
    }

    warning(false, '`getInternalHooks` is internal usage. Should not call directly.');
    return null;
  };

  private useSubscribe = (subscribable: boolean) => {
    this.subscribable = subscribable;
  };

  /**
   * Record prev Form unmount fieldEntities which config preserve false.
   * This need to be refill with initialValues instead of store value.
   */
  private prevWithoutPreserves: NameMap<boolean> | null = null;

  /**
   * 改变当前 store 默认值，在 Form 内部调用，该方法每次渲染时都会触发，但是除了第一次，后面都只会改变 this.initialValues
   * First time `setInitialValues` should update store with initial value
   */
  private setInitialValues = (initialValues: Store, init: boolean) => {
    this.initialValues = initialValues || {};
    if (init) {
      let nextStore = setValues({}, initialValues, this.store);

      // 如果原来还有没有删除的字段，需要赋值为原来的
      // We will take consider prev form unmount fields.
      // When the field is not `preserve`, we need fill this with initialValues instead of store.
      // eslint-disable-next-line array-callback-return
      this.prevWithoutPreserves?.map(({ key: namePath }) => {
        nextStore = setValue(nextStore, namePath, getValue(initialValues, namePath));
      });
      this.prevWithoutPreserves = null;

      this.updateStore(nextStore);
    }
  };

  /**
   * 销毁 form，获取不需要保存原本字段值的字段
   */
  private destroyForm = () => {
    const prevWithoutPreserves = new NameMap<boolean>();
    this.getFieldEntities(true).forEach(entity => {
      // 是否保留原来的字段值
      if (!this.isMergedPreserve(entity.isPreserve())) {
        // 如果不保留原本字段值就标记一下
        prevWithoutPreserves.set(entity.getNamePath(), true);
      }
    });

    this.prevWithoutPreserves = prevWithoutPreserves;
  };

  private getInitialValue = (namePath: InternalNamePath) => {
    const initValue = getValue(this.initialValues, namePath);

    // Not cloneDeep when without `namePath`
    return namePath.length ? cloneDeep(initValue) : initValue;
  };

  private setCallbacks = (callbacks: Callbacks) => {
    this.callbacks = callbacks;
  };

  private setValidateMessages = (validateMessages: ValidateMessages) => {
    this.validateMessages = validateMessages;
  };

  private setPreserve = (preserve?: boolean) => {
    this.preserve = preserve;
  };

  // ============================= Watch ============================
  private watchList: WatchCallBack[] = [];

  /**
   * 注册 watch 回调
   * @param callback
   * @returns
   */
  private registerWatch: InternalHooks['registerWatch'] = callback => {
    this.watchList.push(callback);

    return () => {
      this.watchList = this.watchList.filter(fn => fn !== callback);
    };
  };

  /**
   * 通知改变的值与 namepath，子组件在各种组件中比较
   * @param namePath
   */
  private notifyWatch = (namePath: InternalNamePath[] = []) => {
    // No need to cost perf when nothing need to watch
    if (this.watchList.length) {
      // 获取 key-value 的键值对
      const values = this.getFieldsValue();
      // 通知 useWatch 哪些值改变了 namePath 是改变的 name path
      this.watchList.forEach(callback => {
        callback(values, namePath);
      });
    }
  };

  // ========================== Dev Warning =========================
  private timeoutId: any = null;

  /**
   * 判断是否把 form 传给 Form 组件，没有就报错
   */
  private warningUnhooked = () => {
    if (process.env.NODE_ENV !== 'production' && !this.timeoutId && typeof window !== 'undefined') {
      this.timeoutId = setTimeout(() => {
        this.timeoutId = null;

        if (!this.formHooked) {
          warning(
            false,
            'Instance created by `useForm` is not connected to any Form element. Forget to pass `form` prop?',
          );
        }
      });
    }
  };

  // ============================ Store =============================
  /**
   * 更新 store 中的存储值
   * @param nextStore
   */
  private updateStore = (nextStore: Store) => {
    this.store = nextStore;
  };

  // ============================ Fields ============================
  /**
   * 如果有 pure 证明只返回带有 name 的 filed 字段
   * Get registered field entities.
   * @param pure Only return field which has a `name`. Default: false
   */
  private getFieldEntities = (pure: boolean = false) => {
    if (!pure) {
      return this.fieldEntities;
    }

    return this.fieldEntities.filter(field => field.getNamePath().length);
  };

  /**
   * namePath => Filed 组件
   * @param pure
   * @returns
   */
  private getFieldsMap = (pure: boolean = false) => {
    const cache: NameMap<FieldEntity> = new NameMap();
    this.getFieldEntities(pure).forEach(field => {
      const namePath = field.getNamePath();
      cache.set(namePath, field);
    });
    return cache;
  };

  /**
   * 不传 nameList 返回所哟带有 name 的 Field 字段值
   * namePath 数组 => Field 组件数组
   * @param nameList
   * @returns
   */
  private getFieldEntitiesForNamePathList = (
    nameList?: NamePath[],
  ): (FieldEntity | InvalidateFieldEntity)[] => {
    if (!nameList) {
      return this.getFieldEntities(true);
    }
    const cache = this.getFieldsMap(true);
    return nameList.map(name => {
      const namePath = getNamePath(name);
      return cache.get(namePath) || { INVALIDATE_NAME_PATH: getNamePath(name) };
    });
  };

  /**
   * 获取全部的 fields，传入 true 返回整个 store，最终返回值是一个 key-value 的对象
   * @param nameList
   * @param filterFunc
   * @returns
   */
  private getFieldsValue = (nameList?: NamePath[] | true, filterFunc?: (meta: Meta) => boolean) => {
    this.warningUnhooked();

    if (nameList === true && !filterFunc) {
      return this.store;
    }

    // nameList 为空数组 fieldEntities 才为空
    const fieldEntities = this.getFieldEntitiesForNamePathList(
      Array.isArray(nameList) ? nameList : null,
    );

    const filteredNameList: NamePath[] = [];
    fieldEntities.forEach((entity: FieldEntity | InvalidateFieldEntity) => {
      const namePath =
        'INVALIDATE_NAME_PATH' in entity ? entity.INVALIDATE_NAME_PATH : entity.getNamePath();

      // 当它是一个列表项并且不指定 namePath 时，忽略它，
      // 因为父字段已经在计数
      // Ignore when it's a list item and not specific the namePath,
      // since parent field is already take in count
      if (!nameList && (entity as FieldEntity).isListField?.()) {
        return;
      }

      if (!filterFunc) {
        filteredNameList.push(namePath);
      } else {
        const meta: Meta = 'getMeta' in entity ? entity.getMeta() : null;
        if (filterFunc(meta)) {
          filteredNameList.push(namePath);
        }
      }
    });

    return cloneByNamePathList(this.store, filteredNameList.map(getNamePath));
  };

  private getFieldValue = (name: NamePath) => {
    this.warningUnhooked();

    const namePath: InternalNamePath = getNamePath(name);
    return getValue(this.store, namePath);
  };

  private getFieldsError = (nameList?: NamePath[]) => {
    this.warningUnhooked();

    const fieldEntities = this.getFieldEntitiesForNamePathList(nameList);

    return fieldEntities.map((entity, index) => {
      if (entity && !('INVALIDATE_NAME_PATH' in entity)) {
        return {
          name: entity.getNamePath(),
          errors: entity.getErrors(),
          warnings: entity.getWarnings(),
        };
      }

      return {
        name: getNamePath(nameList[index]),
        errors: [],
        warnings: [],
      };
    });
  };

  private getFieldError = (name: NamePath): string[] => {
    this.warningUnhooked();

    const namePath = getNamePath(name);
    const fieldError = this.getFieldsError([namePath])[0];
    return fieldError.errors;
  };

  private getFieldWarning = (name: NamePath): string[] => {
    this.warningUnhooked();

    const namePath = getNamePath(name);
    const fieldError = this.getFieldsError([namePath])[0];
    return fieldError.warnings;
  };

  private isFieldsTouched = (...args) => {
    this.warningUnhooked();

    const [arg0, arg1] = args;
    let namePathList: InternalNamePath[] | null;
    let isAllFieldsTouched = false;

    if (args.length === 0) {
      namePathList = null;
    } else if (args.length === 1) {
      if (Array.isArray(arg0)) {
        namePathList = arg0.map(getNamePath);
        isAllFieldsTouched = false;
      } else {
        namePathList = null;
        isAllFieldsTouched = arg0;
      }
    } else {
      namePathList = arg0.map(getNamePath);
      isAllFieldsTouched = arg1;
    }

    const fieldEntities = this.getFieldEntities(true);
    const isFieldTouched = (field: FieldEntity) => field.isFieldTouched();

    // ===== Will get fully compare when not config namePathList =====
    if (!namePathList) {
      return isAllFieldsTouched
        ? fieldEntities.every(isFieldTouched)
        : fieldEntities.some(isFieldTouched);
    }

    // Generate a nest tree for validate
    const map = new NameMap<FieldEntity[]>();
    namePathList.forEach(shortNamePath => {
      map.set(shortNamePath, []);
    });

    fieldEntities.forEach(field => {
      const fieldNamePath = field.getNamePath();

      // Find matched entity and put into list
      namePathList.forEach(shortNamePath => {
        if (shortNamePath.every((nameUnit, i) => fieldNamePath[i] === nameUnit)) {
          map.update(shortNamePath, list => [...list, field]);
        }
      });
    });

    // Check if NameMap value is touched
    const isNamePathListTouched = (entities: FieldEntity[]) => entities.some(isFieldTouched);

    const namePathListEntities = map.map(({ value }) => value);

    return isAllFieldsTouched
      ? namePathListEntities.every(isNamePathListTouched)
      : namePathListEntities.some(isNamePathListTouched);
  };

  private isFieldTouched = (name: NamePath) => {
    this.warningUnhooked();
    return this.isFieldsTouched([name]);
  };

  private isFieldsValidating = (nameList?: NamePath[]) => {
    this.warningUnhooked();

    const fieldEntities = this.getFieldEntities();
    if (!nameList) {
      return fieldEntities.some(testField => testField.isFieldValidating());
    }

    const namePathList: InternalNamePath[] = nameList.map(getNamePath);
    return fieldEntities.some(testField => {
      const fieldNamePath = testField.getNamePath();
      return containsNamePath(namePathList, fieldNamePath) && testField.isFieldValidating();
    });
  };

  private isFieldValidating = (name: NamePath) => {
    this.warningUnhooked();

    return this.isFieldsValidating([name]);
  };

  /**
   * 将 Field 更新为 initialValue 的值
   * Reset Field with field `initialValue` prop.
   * Can pass `entities` or `namePathList` or just nothing.
   */
  private resetWithFieldInitialValue = (
    info: {
      entities?: FieldEntity[];
      namePathList?: InternalNamePath[];
      // 如果是初始化就跳过 reset 值
      /** Skip reset if store exist value. This is only used for field register reset */
      skipExist?: boolean;
    } = {},
  ) => {
    // Create cache
    const cache: NameMap<Set<{ entity: FieldEntity; value: any }>> = new NameMap();

    const fieldEntities = this.getFieldEntities(true);
    // 记录初始值
    fieldEntities.forEach(field => {
      const { initialValue } = field.props;
      const namePath = field.getNamePath();

      // Record only if has `initialValue`
      if (initialValue !== undefined) {
        // Field 字段可能会相同的
        const records = cache.get(namePath) || new Set();
        records.add({ entity: field, value: initialValue });

        cache.set(namePath, records);
      }
    });

    // Reset
    const resetWithFields = (entities: FieldEntity[]) => {
      entities.forEach(field => {
        const { initialValue } = field.props;

        if (initialValue !== undefined) {
          const namePath = field.getNamePath();
          const formInitialValue = this.getInitialValue(namePath);
          // 如果 form 设置了 initialValue，就不要 field 的 initialValue 了
          if (formInitialValue !== undefined) {
            // Warning if conflict with form initialValues and do not modify value
            warning(
              false,
              `Form already set 'initialValues' with path '${namePath.join(
                '.',
              )}'. Field can not overwrite it.`,
            );
          } else {
            const records = cache.get(namePath);
            if (records && records.size > 1) {
              // Warning if multiple field set `initialValue`and do not modify value
              warning(
                false,
                `Multiple Field with path '${namePath.join(
                  '.',
                )}' set 'initialValue'. Can not decide which one to pick.`,
              );
              // 有 1 个记录值
            } else if (records) {
              // 也会改变 store
              const originValue = this.getFieldValue(namePath);
              // Set `initialValue`
              // 如果现在没有值也会重置
              if (!info.skipExist || originValue === undefined) {
                this.updateStore(setValue(this.store, namePath, [...records][0].value));
              }
            }
          }
        }
      });
    };

    let requiredFieldEntities: FieldEntity[];
    if (info.entities) {
      requiredFieldEntities = info.entities;
      // 通过 namePath 获取
    } else if (info.namePathList) {
      requiredFieldEntities = [];

      info.namePathList.forEach(namePath => {
        const records = cache.get(namePath);
        if (records) {
          requiredFieldEntities.push(...[...records].map(r => r.entity));
        }
      });
      // 默认为传入了 initialValue 的 Field
    } else {
      requiredFieldEntities = fieldEntities;
    }

    resetWithFields(requiredFieldEntities);
  };

  /**
   * 重置 fields 值为 initialValue
   * @param nameList
   * @returns
   */
  private resetFields = (nameList?: NamePath[]) => {
    this.warningUnhooked();

    const prevStore = this.store;
    // 如果没有传 nameList 全部更新
    if (!nameList) {
      this.updateStore(setValues({}, this.initialValues));
      this.resetWithFieldInitialValue();
      this.notifyObservers(prevStore, null, { type: 'reset' });
      this.notifyWatch();
      return;
    }

    // Reset by `nameList`
    const namePathList: InternalNamePath[] = nameList.map(getNamePath);
    namePathList.forEach(namePath => {
      const initialValue = this.getInitialValue(namePath);
      this.updateStore(setValue(this.store, namePath, initialValue));
    });
    this.resetWithFieldInitialValue({ namePathList });
    this.notifyObservers(prevStore, namePathList, { type: 'reset' });
    this.notifyWatch(namePathList);
  };

  /**
   * 改变 fields 字段值，同时通知 watch 与 Field
   * @param fields
   */
  private setFields = (fields: FieldData[]) => {
    this.warningUnhooked();

    const prevStore = this.store;

    const namePathList: InternalNamePath[] = [];

    fields.forEach((fieldData: FieldData) => {
      const { name, errors, ...data } = fieldData;
      // 更新的值
      const namePath = getNamePath(name);
      namePathList.push(namePath);

      // Value，value 代表有值更新，同时要同步更新 store 中的 value 值
      if ('value' in data) {
        this.updateStore(setValue(this.store, namePath, data.value));
      }
      // filed 改变，通知监听器
      this.notifyObservers(prevStore, [namePath], {
        type: 'setField',
        data: fieldData,
      });
    });

    // 通知哪些值改变了
    this.notifyWatch(namePathList);
  };

  /**
   * 获取 files 的 meta
   * @returns
   */
  private getFields = (): InternalFieldData[] => {
    const entities = this.getFieldEntities(true);

    const fields = entities.map((field: FieldEntity): InternalFieldData => {
      const namePath = field.getNamePath();
      const meta = field.getMeta();
      const fieldData = {
        ...meta,
        name: namePath,
        value: this.getFieldValue(namePath),
      };

      Object.defineProperty(fieldData, 'originRCField', {
        value: true,
      });

      return fieldData;
    });

    return fields;
  };

  // =========================== Observer ===========================
  /**
   * 避免初始值获取太晚，改变 store，这里没有通知 Filed 值改变
   * This only trigger when a field is on constructor to avoid we get initialValue too late
   */
  private initEntityValue = (entity: FieldEntity) => {
    const { initialValue } = entity.props;

    // 更新 Field 对应字段的初始值
    if (initialValue !== undefined) {
      const namePath = entity.getNamePath();
      const prevValue = getValue(this.store, namePath);

      // 判断是否 Form 传入了 value
      if (prevValue === undefined) {
        // 改变 store
        this.updateStore(setValue(this.store, namePath, initialValue));
      }
    }
  };

  /**
   * filed
   * @param fieldPreserve
   * @returns
   */
  private isMergedPreserve = (fieldPreserve?: boolean) => {
    const mergedPreserve = fieldPreserve !== undefined ? fieldPreserve : this.preserve;
    return mergedPreserve ?? true;
  };

  /**
   * entity 实际上就是 Field 组件，在 ComponentDidMount 时触发，会返回一个取消 field 注册的方法，这里会通知值改变，在 initEntityValue 之后
   * @param entity
   * @returns
   */
  private registerField = (entity: FieldEntity) => {
    this.fieldEntities.push(entity);
    const namePath = entity.getNamePath();
    // 通知 useWatch 已经注册了一个 name，监听相应 namePath 的 watch 值会改变
    this.notifyWatch([namePath]);

    // 如果用户在 Field 中设置了 initialValue
    // Set initial values
    if (entity.props.initialValue !== undefined) {
      const prevStore = this.store;
      // 这里跳过了更新值，函数本身不会有 Effect 操作，主要是用于提示给用户 warning
      this.resetWithFieldInitialValue({ entities: [entity], skipExist: true });
      // 通知值改变，空值 => initialValue，在 constructor 中已经改变过 store 了
      this.notifyObservers(prevStore, [entity.getNamePath()], {
        type: 'valueUpdate',
        source: 'internal',
      });
    }

    /// 注销 field 也会伴随值的改变
    // un-register field callback
    return (isListField?: boolean, preserve?: boolean, subNamePath: InternalNamePath = []) => {
      // 过滤
      this.fieldEntities = this.fieldEntities.filter(item => item !== entity);

      // 清除数据
      // Clean up store value if not preserve
      // 如果不保留值并且如果是 List，List 内部要有 Field
      if (!this.isMergedPreserve(preserve) && (!isListField || subNamePath.length > 1)) {
        // 默认值
        const defaultValue = isListField ? undefined : this.getInitialValue(namePath);

        if (
          namePath.length &&
          this.getFieldValue(namePath) !== defaultValue &&
          // 当没有 Filed 对应的 name 存在才能清除（有可能不同 Field 统一的 path）
          this.fieldEntities.every(
            field =>
              // Only reset when no namePath exist
              !matchNamePath(field.getNamePath(), namePath),
          )
        ) {
          const prevStore = this.store;
          // 重置值，恢复默认值
          this.updateStore(setValue(prevStore, namePath, defaultValue, true));

          // Notify that field is unmount
          this.notifyObservers(prevStore, [namePath], { type: 'remove' });

          // Dependencies update
          this.triggerDependenciesUpdate(prevStore, namePath);
        }
      }

      this.notifyWatch([namePath]);
    };
  };

  /**
   * updateValue 修改值，validateField 验证 Fields
   * @param action
   */
  private dispatch = (action: ReducerAction) => {
    switch (action.type) {
      case 'updateValue': {
        const { namePath, value } = action;
        this.updateValue(namePath, value);
        break;
      }
      case 'validateField': {
        const { namePath, triggerName } = action;
        this.validateFields([namePath], { triggerName });
        break;
      }
      default:
      // Currently we don't have other action. Do nothing.
    }
  };

  /**
   * 监听值更新，写入回调，如果传入 Form 内部的为 function，则强制刷新组件，二次渲染 Form
   * @param prevStore
   * @param namePathList
   * @param info
   */
  private notifyObservers = (
    prevStore: Store,
    namePathList: InternalNamePath[] | null,
    info: NotifyInfo,
  ) => {
    // 如果传入 Form 内部的为 function，此处为 false
    if (this.subscribable) {
      // info 里面有 type 与对应 type 绑定的值
      const mergedInfo: ValuedNotifyInfo = {
        ...info,
        store: this.getFieldsValue(true),
      };
      // onStoreChange 是 Filed 组件的
      this.getFieldEntities().forEach(({ onStoreChange }) => {
        // 当值更新时通知 Filed 哪些字段被更改了，并加入相关 meta info
        onStoreChange(prevStore, namePathList, mergedInfo);
      });
    } else {
      this.forceRootUpdate();
    }
  };

  /**
   * 通知所有监听了某个字段的 Field 触发更新
   * Notify dependencies children with parent update
   * We need delay to trigger validate in case Field is under render props
   */
  private triggerDependenciesUpdate = (prevStore: Store, namePath: InternalNamePath) => {
    const childrenFields = this.getDependencyChildrenFields(namePath);
    // 触发表单校验， childrenFields 内的字段会重新校验
    if (childrenFields.length) {
      this.validateFields(childrenFields);
    }

    this.notifyObservers(prevStore, childrenFields, {
      type: 'dependenciesUpdate',
      relatedFields: [namePath, ...childrenFields],
    });

    return childrenFields;
  };

  private updateValue = (name: NamePath, value: StoreValue) => {
    const namePath = getNamePath(name);
    const prevStore = this.store;
    this.updateStore(setValue(this.store, namePath, value));

    this.notifyObservers(prevStore, [namePath], {
      type: 'valueUpdate',
      source: 'internal',
    });
    this.notifyWatch([namePath]);

    // 已经通知更新的 fields
    // Dependencies update
    const childrenFields = this.triggerDependenciesUpdate(prevStore, namePath);

    // 回调除非
    // trigger callback function
    const { onValuesChange } = this.callbacks;

    if (onValuesChange) {
      const changedValues = cloneByNamePathList(this.store, [namePath]);
      onValuesChange(changedValues, this.getFieldsValue());
    }

    // fields on change 的回调触发
    this.triggerOnFieldsChange([namePath, ...childrenFields]);
  };

  // 修改所有值
  // Let all child Field get update.
  private setFieldsValue = (store: Store) => {
    this.warningUnhooked();

    const prevStore = this.store;

    if (store) {
      const nextStore = setValues(this.store, store);
      this.updateStore(nextStore);
    }

    this.notifyObservers(prevStore, null, {
      type: 'valueUpdate',
      source: 'external',
    });
    this.notifyWatch();
  };

  private setFieldValue = (name: NamePath, value: any) => {
    this.setFields([
      {
        name,
        value,
      },
    ]);
  };

  /**
   * 返回所有 Filed 内 rootNamePath 字段相关 deps 的子字段
   * 如果是依赖 path，获取该 path 下的所有子 path 的 path
   * @param rootNamePath
   * @returns
   */
  private getDependencyChildrenFields = (rootNamePath: InternalNamePath): InternalNamePath[] => {
    const children: Set<FieldEntity> = new Set();
    const childrenFields: InternalNamePath[] = [];

    const dependencies2fields: NameMap<Set<FieldEntity>> = new NameMap();

    /**
     * 遍历所有的 Field
     * Generate maps
     * Can use cache to save perf if user report performance issue with this
     */
    this.getFieldEntities().forEach(field => {
      const { dependencies } = field.props;
      (dependencies || []).forEach(dependency => {
        const dependencyNamePath = getNamePath(dependency);
        // 添加 field 到 <dependency, Set<field>> 中
        dependencies2fields.update(dependencyNamePath, (fields = new Set()) => {
          fields.add(field);
          return fields;
        });
      });
    });

    const fillChildren = (namePath: InternalNamePath) => {
      const fields = dependencies2fields.get(namePath) || new Set();
      // 所有 deps 有 namePath 的 Field
      fields.forEach(field => {
        // 防止重复的 Field
        if (!children.has(field)) {
          children.add(field);

          const fieldNamePath = field.getNamePath();
          // 字段有需要展示
          if (field.isFieldDirty() && fieldNamePath.length) {
            // 添加子 fieldPath，然后继续递归
            childrenFields.push(fieldNamePath);
            fillChildren(fieldNamePath);
          }
        }
      });
    };

    fillChildren(rootNamePath);

    return childrenFields;
  };

  /**
   * 用户给 Form 传了 onFieldsChange 回调触发
   * @param namePathList
   * @param filedErrors
   */
  private triggerOnFieldsChange = (
    namePathList: InternalNamePath[],
    filedErrors?: FieldError[],
  ) => {
    const { onFieldsChange } = this.callbacks;

    if (onFieldsChange) {
      const fields = this.getFields();

      /**
       * 如果有错误抛错
       * Fill errors since `fields` may be replaced by controlled fields
       */
      if (filedErrors) {
        const cache = new NameMap<string[]>();
        // 相同 name 的错后面的覆盖前面的
        filedErrors.forEach(({ name, errors }) => {
          cache.set(name, errors);
        });
        // 直接修改 field meta 的 errors
        fields.forEach(field => {
          // eslint-disable-next-line no-param-reassign
          field.errors = cache.get(field.name) || field.errors;
        });
      }

      // 过滤被修改的 Fields
      const changedFields = fields.filter(({ name: fieldName }) =>
        containsNamePath(namePathList, fieldName as InternalNamePath),
      );
      onFieldsChange(changedFields, fields);
    }
  };

  // =========================== Validate ===========================
  // 表单验证逻辑
  private validateFields: InternalValidateFields = (
    nameList?: NamePath[],
    options?: ValidateOptions,
  ) => {
    this.warningUnhooked();

    const provideNameList = !!nameList;
    const namePathList: InternalNamePath[] | undefined = provideNameList
      ? nameList.map(getNamePath)
      : [];

    // 获取表单验证结果
    // Collect result in promise list
    const promiseList: Promise<FieldError>[] = [];

    this.getFieldEntities(true).forEach((field: FieldEntity) => {
      // Add field if not provide `nameList`
      if (!provideNameList) {
        namePathList.push(field.getNamePath());
      }

      /**
       * Recursive validate if configured.
       * TODO: perf improvement @zombieJ
       */
      if (options?.recursive && provideNameList) {
        const namePath = field.getNamePath();
        // 递归推入
        if (
          // nameList[i] === undefined 说明是以 nameList 开头的
          // ['name'] -> ['name','list']
          namePath.every((nameUnit, i) => nameList[i] === nameUnit || nameList[i] === undefined)
        ) {
          namePathList.push(namePath);
        }
      }

      // Skip if without rule
      if (!field.props.rules || !field.props.rules.length) {
        return;
      }

      const fieldNamePath = field.getNamePath();
      // Add field validate rule in to promise list
      // 开始验证
      if (!provideNameList || containsNamePath(namePathList, fieldNamePath)) {
        const promise = field.validateRules({
          validateMessages: {
            ...defaultValidateMessages,
            ...this.validateMessages,
          },
          ...options,
        });

        // 获取报错信息
        // Wrap promise with field
        promiseList.push(
          promise
            .then<any, RuleError>(() => ({ name: fieldNamePath, errors: [], warnings: [] }))
            .catch((ruleErrors: RuleError[]) => {
              const mergedErrors: string[] = [];
              const mergedWarnings: string[] = [];

              ruleErrors.forEach?.(({ rule: { warningOnly }, errors }) => {
                if (warningOnly) {
                  mergedWarnings.push(...errors);
                } else {
                  mergedErrors.push(...errors);
                }
              });

              if (mergedErrors.length) {
                return Promise.reject({
                  name: fieldNamePath,
                  errors: mergedErrors,
                  warnings: mergedWarnings,
                });
              }

              return {
                name: fieldNamePath,
                errors: mergedErrors,
                warnings: mergedWarnings,
              };
            }),
        );
      }
    });

    // 所有字段全部校验完毕
    const summaryPromise = allPromiseFinish(promiseList);
    this.lastValidatePromise = summaryPromise;

    // Notify fields with rule that validate has finished and need update
    summaryPromise
      .catch(results => results)
      .then((results: FieldError[]) => {
        const resultNamePathList: InternalNamePath[] = results.map(({ name }) => name);
        this.notifyObservers(this.store, resultNamePathList, {
          type: 'validateFinish',
        });
        // fields相关 meta 字段改变了
        this.triggerOnFieldsChange(resultNamePathList, results);
      });

    const returnPromise: Promise<Store | ValidateErrorEntity | string[]> = summaryPromise
      .then((): Promise<Store | string[]> => {
        // 和 Field 一样，只要最后一次调用的
        if (this.lastValidatePromise === summaryPromise) {
          // 如果验证成功，获取 Form 值，如果验证失败，在 catch 获取报错
          return Promise.resolve(this.getFieldsValue(namePathList));
        }
        return Promise.reject<string[]>([]);
      })
      .catch((results: { name: InternalNamePath; errors: string[] }[]) => {
        const errorList = results.filter(result => result && result.errors.length);
        return Promise.reject({
          values: this.getFieldsValue(namePathList),
          errorFields: errorList,
          outOfDate: this.lastValidatePromise !== summaryPromise,
        });
      });

    // 不要在 console 报错
    // Do not throw in console
    returnPromise.catch<ValidateErrorEntity>(e => e);

    return returnPromise as Promise<Store>;
  };

  // ============================ Submit ============================
  // 提交前先验证，然后调用回调 onFinish
  private submit = () => {
    this.warningUnhooked();

    this.validateFields()
      .then(values => {
        const { onFinish } = this.callbacks;
        if (onFinish) {
          try {
            onFinish(values);
          } catch (err) {
            // Should print error if user `onFinish` callback failed
            console.error(err);
          }
        }
      })
      .catch(e => {
        const { onFinishFailed } = this.callbacks;
        if (onFinishFailed) {
          onFinishFailed(e);
        }
      });
  };
}

/**
 * 获取 Form 实例
 * @param form
 * @returns
 */
function useForm<Values = any>(form?: FormInstance<Values>): [FormInstance<Values>] {
  const formRef = React.useRef<FormInstance>();
  const [, forceUpdate] = React.useState({});

  // 只渲染一次
  if (!formRef.current) {
    if (form) {
      formRef.current = form;
    } else {
      // Create a new FormStore if not provided
      const forceReRender = () => {
        forceUpdate({});
      };
      const formStore: FormStore = new FormStore(forceReRender);

      // 如果没有传入 form，生成一个
      formRef.current = formStore.getForm();
    }
  }

  return [formRef.current];
}

export default useForm;
