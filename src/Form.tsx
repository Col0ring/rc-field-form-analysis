import * as React from 'react';
import type {
  Store,
  FormInstance,
  FieldData,
  ValidateMessages,
  Callbacks,
  InternalFormInstance,
} from './interface';
import useForm from './useForm';
import FieldContext, { HOOK_MARK } from './FieldContext';
import type { FormContextProps } from './FormContext';
import FormContext from './FormContext';
import { isSimilar } from './utils/valueUtil';

type BaseFormProps = Omit<React.FormHTMLAttributes<HTMLFormElement>, 'onSubmit' | 'children'>;

type RenderProps = (values: Store, form: FormInstance) => JSX.Element | React.ReactNode;

export interface FormProps<Values = any> extends BaseFormProps {
  initialValues?: Store;
  form?: FormInstance<Values>;
  children?: RenderProps | React.ReactNode;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component?: false | string | React.FC<any> | React.ComponentClass<any>;
  fields?: FieldData[];
  name?: string;
  validateMessages?: ValidateMessages;
  onValuesChange?: Callbacks<Values>['onValuesChange'];
  onFieldsChange?: Callbacks<Values>['onFieldsChange'];
  onFinish?: Callbacks<Values>['onFinish'];
  onFinishFailed?: Callbacks<Values>['onFinishFailed'];
  validateTrigger?: string | string[] | false;
  preserve?: boolean;
}

const Form: React.ForwardRefRenderFunction<FormInstance, FormProps> = (
  {
    name,
    initialValues,
    fields,
    form,
    preserve,
    children,
    component: Component = 'form',
    validateMessages,
    validateTrigger = 'onChange',
    onValuesChange,
    onFieldsChange,
    onFinish,
    onFinishFailed,
    ...restProps
  }: FormProps,
  ref,
) => {
  // 服务 FormProvider，用户表单联动
  const formContext: FormContextProps = React.useContext(FormContext);

  // We customize handle event since Context will makes all the consumer re-render:
  // https://reactjs.org/docs/context.html#contextprovider
  // 获取上下文 form instances
  const [formInstance] = useForm(form);
  // 此时已经与传入的上下文相关联，useForm 拿到的其实就是 InternalFormInstance 对象，只是为了限制用户的使用，强行改为了 FormInstance
  const {
    useSubscribe,
    setInitialValues,
    setCallbacks,
    setValidateMessages,
    setPreserve,
    destroyForm,
  } = (formInstance as InternalFormInstance).getInternalHooks(HOOK_MARK);

  // 可以通过 ref 获取内部的 formInstance，不用使用 useForm 的 form
  // Pass ref with form instance
  React.useImperativeHandle(ref, () => formInstance);

  // Register form into Context
  React.useEffect(() => {
    // 如果有 name 会注册当前的 formInstance
    formContext.registerForm(name, formInstance);
    return () => {
      formContext.unregisterForm(name);
    };
  }, [formContext, formInstance, name]);

  // 页面渲染时直接同步设置验证信息
  // Pass props to store
  setValidateMessages({
    ...formContext.validateMessages,
    ...validateMessages,
  });
  // 设置用户回调给 formInstance
  setCallbacks({
    onValuesChange,
    // 这里将所有函数绑定都放入 formStore 中
    onFieldsChange: (changedFields: FieldData[], ...rest) => {
      // 额外通知 formContext
      formContext.triggerFormChange(name, changedFields);

      if (onFieldsChange) {
        onFieldsChange(changedFields, ...rest);
      }
    },
    onFinish: (values: Store) => {
      // 额外通知 formContext
      formContext.triggerFormFinish(name, values);

      if (onFinish) {
        onFinish(values);
      }
    },
    onFinishFailed,
  });
  // 同步设置是否保留原来的字段值
  setPreserve(preserve);

  // Set initial value, init store value when first mount
  const mountRef = React.useRef(null);
  // 同步设置初始值
  setInitialValues(initialValues, !mountRef.current);
  if (!mountRef.current) {
    mountRef.current = true;
  }

  // clean up
  React.useEffect(
    () => destroyForm,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Prepare children by `children` type
  let childrenNode: React.ReactNode;
  const childrenRenderProps = typeof children === 'function';
  if (childrenRenderProps) {
    const values = formInstance.getFieldsValue(true);
    // 如果传入了 function，那么将所有的 filed 值和当前的 formInstance 也传入
    childrenNode = (children as RenderProps)(values, formInstance);
  } else {
    childrenNode = children;
  }

  // 当没有传 function 作为 children 时会开启 Subscribe
  // Not use subscribe when using render props
  useSubscribe(!childrenRenderProps);

  // Listen if fields provided. We use ref to save prev data here to avoid additional render
  // 防止二次渲染
  const prevFieldsRef = React.useRef<FieldData[] | undefined>();
  // 监听外部 fields 的传入状态，这个一般不会手动使用，而是与 redux 等配合在外界跨组件控制表单的展示
  React.useEffect(() => {
    // 比较完成不一致后才渲染
    if (!isSimilar(prevFieldsRef.current || [], fields || [])) {
      formInstance.setFields(fields || []);
    }
    prevFieldsRef.current = fields;
  }, [fields, formInstance]);

  const formContextValue = React.useMemo(
    () => ({
      ...(formInstance as InternalFormInstance),
      // 校验触发事件
      validateTrigger,
    }),
    [formInstance, validateTrigger],
  );

  const wrapperNode = (
    <FieldContext.Provider value={formContextValue}>{childrenNode}</FieldContext.Provider>
  );

  // 如果没有设置最外层 Component，默认只渲染子组件加 context
  if (Component === false) {
    return wrapperNode;
  }

  return (
    <Component
      {...restProps}
      // 表单提交与重置
      onSubmit={(event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        event.stopPropagation();
        // 这里会验证表单
        formInstance.submit();
      }}
      onReset={(event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        formInstance.resetFields();
        restProps.onReset?.(event);
      }}
    >
      {wrapperNode}
    </Component>
  );
};

export default Form;
